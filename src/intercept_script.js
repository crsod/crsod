// Max time adjustment (on top of duration adjustment) we're willing to make
// based on fuzzy script comparison.
//
// Since the comparison between two scripts can potentially go wrong, the idea
// here is that a too large value is probably incorrect and it'd be better to
// just go with duration-based adjustment in that case.
const SCRIPT_MAX_ADJUST = 60000;


class ScriptRewriteContext {
    /**
     * @param {string} url URL of script to be rewritten
     * @param {PlayResponse} media Media object being viewed (i.e. dub)
     * @param {string} lang Language of script being intercepted
     * @param {Promise<number>} duration Duration (ms) of video being viewed
     * @param {Promise<number>} alt_duration Duration (ms) of alternative video (i.e. JP)
     * @param {Promise<string|null>} dub_fetch Script of original subs for dub lang
     * @param {Promise<string|null>} dub_alt_fetch Script of alternative subs for dub lang
     * @param {Object} subs Raw subs object from current media object
     * @param {Object} alt_subs Raw subs object from alternative media object
     */
    constructor(url, media, lang, duration, alt_duration, dub_fetch, dub_alt_fetch, subs, alt_subs) {
        this.url = url;
        this.media = media;
        this.lang = lang;
        this.duration = duration;
        this.alt_duration = alt_duration;
        this.dub_fetch = dub_fetch;
        this.dub_alt_fetch = dub_alt_fetch;
        this.subs = JSON.parse(JSON.stringify(subs));
        this.alt_subs = JSON.parse(JSON.stringify(alt_subs));
    }
}

/**
 * An interceptor for a single script request in progress.
 */
class ScriptInterceptor extends Interceptor {
    static _INTERCEPT = [];
    static _MAX_INTERCEPT = 50;

    static register(ctx) {
        ScriptInterceptor._INTERCEPT.push(ctx);
        while (ScriptInterceptor._INTERCEPT.length > ScriptInterceptor._MAX_INTERCEPT) {
            // Clean up older entries
            ScriptInterceptor._INTERCEPT.shift();
        }
    }

    static unregister(url) {
        ScriptInterceptor._INTERCEPT = ScriptInterceptor._INTERCEPT.filter((ctx) => ctx.url != url);
    }

    static context_for(url) {
        return ScriptInterceptor._INTERCEPT.find((ctx) => ctx.url == url);
    }

    /**
     * Listener for requests to script assets.
     *
     * Filters and rewrites script responses only if a script URL has been
     * previously registered.
     */
    static listener(request) {
        let ctx = ScriptInterceptor.context_for(request.url);
        if (!ctx) {
            // Video fragments go through here as well, so this is a little
            // too verbose and misleading.
            // console.debug(`Ignoring request (script): ${request.url}`);
            return;
        }

        console.debug(`Intercepting script for adjustment: ${request.url}`);
        new ScriptInterceptor(request, ctx);
    }

    /**
     * @param {ScriptRewriteContext} ctx Context for script adjustment
     */
    constructor(request, ctx) {
        super(request);
        this.ctx = ctx;
    }

    async oncomplete(body) {
        let adjust = await this.calculate_adjustment();
        return this.adjust_times(body, adjust);
    }

    onerror(error) {
        // If any error occurs, unregister this URL to break any infinite loops.
        let url = this.url();
        console.warn(`Unregistering ${url} due to error`);
        ScriptInterceptor.unregister(url);
        super.onerror(error);
    }

    /**
     * 
     * @param {string} script Script to be adjusted
     * @returns {Promise<number>} Proposed adjustment in milliseconds
     */
    async calculate_adjustment() {
        let duration_adjust = await this.calculate_duration_adjustment();

        let dub_lang = this.ctx.media.audio_lang();
        let sub = this.ctx.subs[dub_lang];
        let alt_sub = this.ctx.alt_subs[dub_lang];
        let script_adjust = await this.calculate_script_adjustment(duration_adjust, sub, alt_sub);

        let out = (script_adjust === null) ? duration_adjust : script_adjust;
        let how = (script_adjust === null) ? 'duration' : 'script comparison';
        console.info(`${this.ctx.media.guid()}: times of ${this.ctx.lang} script adjusted by ${out}ms using ${how}`);

        return out;
    }

    /**
     * Calculate a timing adjustment by comparing two video durations.
     *
     * @returns {Promise<number>} difference in duration (milliseconds)
     */
    async calculate_duration_adjustment() {
        let dub_duration = await this.ctx.duration;
        let sub_duration = await this.ctx.alt_duration;
        let diff = dub_duration - sub_duration;
        console.debug("duration diff", diff);
        return diff;
    }

    /**
     * Calculate a timing adjustment by comparing two scripts.
     *
     * @param {number} duration_adjust Current adjustment (ms) based on duration.
     * @param {object} sub Sub object from current media (e.g. en-US)
     * @param {object} altsub Sub object from alternative media (e.g. ja-JP)
     * @returns {Promise<number|null>} Suggested adjustment (ms) or null if calculation fails
     */
    async calculate_script_adjustment(duration_adjust, sub, alt_sub) {
        if (!sub || !alt_sub || sub.format != "ass" || alt_sub.format != "ass") {
            console.debug("Script-based timing adjustment not available");
            return null;
        }

        let script = await this.ctx.dub_fetch;
        let alt_script = await this.ctx.dub_alt_fetch;

        let adjust = script_timing_adjust(script, alt_script);
        if (adjust === null) {
            console.info("Could not calculate any timing adjustment via script comparison");
            return null;
        }

        if (Math.abs(adjust - duration_adjust) > SCRIPT_MAX_ADJUST) {
            console.warn(`Script adjustment of ${adjust} too far from duration adjustment of ${duration_adjust}`);
            return null;
        }

        return adjust;
    }

    /**
     * Try to adjust all Dialogue times in a script.
     * @param {string} script A script in SSA/ASS format
     * @param {number} adjust Timing adjustment (ms)
     * @returns {string} a copy of script with times adjusted by this.adjust
     */
    adjust_times(script, adjust) {
        if (!this.format_ok(script)) {
            console.warn("Unexpected script format, cannot adjust timing");
            return script;
        }

        return script.split("\r\n").map((line) => this.adjust_line(line, adjust)).join("\r\n");
    }

    /**
     * Adjust timing on a single line of Dialogue. 
     * @param {string} line A line from a script.
     * @param {number} adjust A line from a script.
     * @returns {string} A copy of the line with timing adjusted by this.adjust (ms)
     */
    adjust_line(line, adjust) {
        if (!line.startsWith("Dialogue: ")) {
            return line;
        }

        // We have a line like this:
        //
        // Dialogue: 0,0:04:08.01,0:04:10.98,...
        //
        // Time format is: H:MM:SS.hundredths
        //
        // We want to adjust all the times by this.adjust milliseconds.
        let fields = line.split(',');
        fields[1] = this.adjust_timestr(fields[1], adjust);
        fields[2] = this.adjust_timestr(fields[2], adjust);
        return fields.join(',');
    }

    /**
     * Adjust timing on a single Dialogue-format timestamp.
     * @param {string} str A timestamp, e.g. "0:04:08.01"
     * @param {number} adjust A line from a script.
     * @returns {string} A copy of the timestamp adjusted by this.adjust milliseconds
     */
    adjust_timestr(str, adjust) {
        let original_ms = script_parse_time(str);
        return script_render_time(original_ms + adjust);
    }

    /**
     * Check if script format is OK for us to work with.
     * @param {string} script A full script in SSA/ASS format. 
     * @returns {boolean} true if script format is acceptable
     */
    format_ok(script) {
        let idx = script.indexOf("Format: Layer,Start,End,");
        return (idx != -1);
    }
}


browser.webRequest.onBeforeRequest.addListener(ScriptInterceptor.listener, {
    // This is where script/subtitle assets are loaded from.
    urls: ["*://v.vrv.co/*"],
}, ["blocking"]);
