// Language for dubs
const DUB_LANG = 'en-US';

// Language for alternative subs (i.e. the media version from which subs are loaded,
// NOT the language used within the subs)
const ALT_LANG = 'ja-JP';

// The language used when loading alternative subs.
// If same as DUB_LANG, replaces the original subs if any.
const REPLACE_LANG = 'en-US';
// If you switch this to another language, you can switch between original
// and alternative subs in the UI.
// const REPLACE_LANG = 'de-DE';


// Min length of subtitle assets in order to be considered "good".
//
// A lot of content technically has en-US subs, but they are near-empty;
// e.g. containing only text for an opening/closing song, translations of
// some Japanese signs in the video etc. Therefore we cannot simply replace
// subs only in the "no subs available" case, as we'd mostly see that subs
// are available while in reality they're mostly empty.
//
// This threshold is a size in bytes. If the subtitle asset is less than this
// number of bytes in length, it's assumed to be one of these near-empty
// files and we switch on the subtitle replacement logic.
//
// TODO: threshold should probably be a factor of the video duration to
// account for very short or long videos which would naturally have a
// shorter or longer script.
const THRESHOLD = 7500;

const DECODER = new TextDecoder("utf-8");
const ENCODER = new TextEncoder();

// Mapping from script URL to a timing adjustment (in milliseconds)
const TIMING_ADJUST = {};



// Wrapper for response from '/play' endpoint
class PlayResponse {
    constructor(raw) {
        this._raw = raw;
    }

    /**
     * @returns true if this is a dub
     */
    is_dub() {
        return this._raw.audioLocale == DUB_LANG;
    }

    /**
     * @returns GUID of corresponding media using alternative language,
     * or raises.
     */
    alt_guid() {
        let versions = this._raw.versions;
        for (var i = 0; i < versions.length; ++i) {
            let v = versions[i];
            if (v.audio_locale == ALT_LANG) {
                return String(v.guid);
            }
        }
        throw new Error(`Could not find any version with ${ALT_LANG}`);
    }

    /**
     * @returns GUID of this media object.
     */
    guid() {
        let versions = this._raw.versions;
        for (var i = 0; i < versions.length; ++i) {
            let v = versions[i];
            if (v.audio_locale == this._raw.audioLocale) {
                return String(v.guid);
            }
        }
        throw new Error("Could not find current version");
    }

    /**
     * Sets the subtitle object of 'lang' to 'obj'.
     * @param {string} lang Language code e.g. "en-US"
     * @param {object} obj Subtitle metadata as returned from /play endpoint
     */
    set_subs(lang, obj) {
        this._raw['subtitles'][lang] = obj;
    }

    /**
     * @returns {string|null} URL of subtitle asset for 'lang', or null.
     */
    sub_asset_url(lang) {
        try {
            return this._raw.subtitles[lang].url;
        } catch (error) {
            return null;
        }
    }

    /**
     * @returns true if sub replacement should occur.
     */
    async should_replace_sub() {
        let guid = this.guid();
        let alt_guid = this.alt_guid();

        if (!this.is_dub()) {
            console.info(`Not replacing subs for ${guid} as it is not a ${DUB_LANG} dub`);
            return false;
        }

        let sub_url = this.sub_asset_url(DUB_LANG);
        if (sub_url == null) {
            // There are no subs for the desired lang, so we ought to fetch some.
            console.info(`Replacing subs for ${guid} as ${DUB_LANG} subs are missing entirely`);
            return true;
        }

        // There are subs, but they might be no good, let's fetch and see.
        console.debug("Fetching sub asset:", sub_url);
        let assetResponse = await fetch(sub_url);
        let assetText = await assetResponse.text();
        let assetLength = assetText.length;

        // The subs are assumed to be good only if the size is above the threshold.
        if (assetLength > THRESHOLD) {
            console.info(`Not replacing subs for ${guid} as script length of ${assetLength} exceeds threshold`);
            return false;
        }
        console.info(`Replacing subs for ${guid} from ${alt_guid} as script length of ${assetLength} is below threshold`);
        return true;
    }

    /**
     * @returns this object serialized into JSON.
     */
    as_json() {
        return JSON.stringify(this._raw);
    }
}

/**
 * An interceptor for a single script request in progress.
 */
class ScriptInterceptor {
    /**
     * @param {number} adjust A timing adjustment (ms) to be applied to this script.
     */
    constructor(filter, request, adjust) {
        this.filter = filter;
        this.originalRequest = request;
        this.adjust = adjust;
        this.buf = '';
    }

    /**
     * Install callbacks/listeners to begin request processing.
     */
    start() {
        this.filter.ondata = (event) => { this.ondata(event) };
        this.filter.onstop = (event) => { this.onstop() };
        this.filter.onerror = (event) => { this.onerror(this.filter.error) };
        console.debug("started intercept", this.filter);
    }

    /**
     * Called when script fetch has completed normally.
     */
    onstop() {
        this.buf = this.adjust_times(this.buf);
        console.debug("Rewritten script", this.buf);
        this.filter.write(ENCODER.encode(this.buf));
        this.filter.disconnect();

        console.debug(`Script times adjusted by ${this.adjust}ms`);
    }

    /**
     * Try to adjust all Dialogue times in a script by this.adjust milliseconds.
     * @param {string} script A script in SSA/ASS format
     * @returns {string} a copy of script with times adjusted by this.adjust
     */
    adjust_times(script) {
        if (!this.format_ok(script)) {
            console.warn("Unexpected script format, cannot adjust timing");
            return script;
        }

        return script.split("\r\n").map((line) => this.adjust_line(line)).join("\r\n");
    }

    /**
     * Adjust timing on a single line of Dialogue. 
     * @param {string} line A line from a script.
     * @returns {string} A copy of the line with timing adjusted by this.adjust (ms)
     */
    adjust_line(line) {
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
        fields[1] = this.adjust_timestr(fields[1]);
        fields[2] = this.adjust_timestr(fields[2]);
        return fields.join(',');
    }

    /**
     * Adjust timing on a single Dialogue-format timestamp.
     * @param {string} str A timestamp, e.g. "0:04:08.01"
     * @returns {string} A copy of the timestamp adjusted by this.adjust milliseconds
     */
    adjust_timestr(str) {
        let original_ms = script_parse_time(str);
        return script_render_time(original_ms + this.adjust);
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

    onerror(error) {
        console.error("Aborting filter due to error", error);
        this.filter.disconnect();
    }

    ondata(event) {
        let str = DECODER.decode(event.data, { "stream": true });
        this.buf = this.buf + str;
    }
}


/**
 * An interceptor for a single /play request in progress.
 */
class PlayInterceptor {
    constructor(filter, request) {
        this.filter = filter;
        this.originalRequest = request;
    }

    /**
     * Install callbacks/listeners to begin request processing.
     */
    start() {
        this.filter.ondata = (event) => { this.ondata(event).catch((error) => this.onerror(error)) };
        this.filter.onerror = (event) => { this.onerror(this.filter.error) };
    }

    onerror(error) {
        console.error("Aborting filter due to error", error);
        this.filter.disconnect();
    }

    async ondata(event) {
        // TODO: don't assume we get all the data at once?
        let str = DECODER.decode(event.data, { "stream": true });
        let media = new PlayResponse(JSON.parse(str));

        if (!await media.should_replace_sub()) {
            // No sub replacement to be done, just pass through the data.
            this.filter.write(ENCODER.encode(media.as_json()));
            this.filter.disconnect();
            return;
        }

        let guid = media.guid();
        let alt_guid = media.alt_guid();

        let dubUrl = String(this.originalRequest.url);
        let altUrl = dubUrl.replace(guid, alt_guid);
        console.debug("Watching dub", guid, "loading subs from", alt_guid, "via", altUrl);

        let duration_adjust = await this.duration_adjust(guid, alt_guid);

        let response = await fetch(altUrl, { "headers": this.headers() });
        let responseJson = await response.json();

        let sub = media._raw.subtitles[DUB_LANG];
        let altsub = responseJson.subtitles[DUB_LANG];

        var script_adjust = null;
        try {
            script_adjust = await this.script_adjust(duration_adjust, sub, altsub);
        } catch (error) {
            console.warn("Could not adjust times based on script comparison", error);
        }

        if (altsub.format == "ass") {
            let altsub_url = altsub.url;
            let adjust_value = script_adjust || duration_adjust;
            let adjust_how = script_adjust ? "script" : "duration";
            console.info(`Adjusting script time by ${adjust_value} via ${adjust_how} comparison`)
            TIMING_ADJUST[altsub_url] = adjust_value;
        } else {
            console.warn("Unknown sub format, skipping time adjust", altsub);
        }

        altsub.language = REPLACE_LANG;
        media.set_subs(REPLACE_LANG, altsub);
        let rewrote = media.as_json();
        console.debug("Rewritten media:", rewrote);
        this.filter.write(ENCODER.encode(rewrote));
        this.filter.disconnect();
    }

    headers() {
        let headers = this.originalRequest.requestHeaders.map((x) => [x['name'], x['value']]);
        return new Headers(headers);
    }

    /**
     * Calculate a timing adjustment by comparing two video durations.
     *
     * @param {string} guid GUID of first video (dub) 
     * @param {string} alt_guid GUID of second video (sub)
     * @returns {Promise<number>} difference in duration (milliseconds)
     */
    async duration_adjust(guid, alt_guid) {
        let dub_url = `https://www.crunchyroll.com/content/v2/cms/objects/${guid}`;
        let sub_url = `https://www.crunchyroll.com/content/v2/cms/objects/${alt_guid}`;

        let opts = { "headers": this.headers() };
        let dub_promise = fetch(dub_url, opts);
        let sub_promise = fetch(sub_url, opts);

        let dub_meta = await (await dub_promise).json();
        let sub_meta = await (await sub_promise).json();

        let dub_duration = dub_meta.data[0].episode_metadata.duration_ms;
        let sub_duration = sub_meta.data[0].episode_metadata.duration_ms;

        let diff = dub_duration - sub_duration;
        console.debug("dub duration", dub_duration);
        console.debug("sub duration", sub_duration);
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
    async script_adjust(duration_adjust, sub, altsub) {
        if (!sub || !altsub || sub.format != "ass" || altsub.format != "ass") {
            console.debug("Script-based timing adjustment not available");
            return null;
        }

        let subfetch = fetch(sub.url);
        let altsubfetch = fetch(altsub.url);
        let script = await (await subfetch).text();
        let altscript = await (await altsubfetch).text();

        let adjust = script_timing_adjust(script, altscript);
        if (!adjust) {
            console.info("Could not calculate any timing adjustment via script comparison");
            return null;
        }

        if (Math.abs(adjust - duration_adjust) > 2000) {
            console.warn(`Script adjustment of ${adjust} too far from duration adjustment of ${duration_adjust}`);
            return null
        }

        return adjust;
    }
}

/**
 * Listener for requests to script assets.
 *
 * Filters and rewrites responses if (and only if) there is a timing adjustment to be
 * made on the script being fetched.
 */
function scriptListener(request) {
    let adjust = TIMING_ADJUST[request.url];
    if (!adjust) {
        console.debug(`Ignoring request (script): ${request.url}`);
        return;
    }

    console.debug(`Loading (script) for adjustment (${adjust}): ${request.url}`);
    let filter = browser.webRequest.filterResponseData(request.requestId);
    let intercept = new ScriptInterceptor(filter, request, adjust);
    intercept.start();
}

/**
 * Listener for requests to the /play endpoint.
 *
 * Filters and rewrites responses to add missing subtitle metadata.
 */
function playListener(request) {
    console.debug(`Loading (play): ${request.url}`);

    let filter = browser.webRequest.filterResponseData(request.requestId);
    let intercept = new PlayInterceptor(filter, request);
    intercept.start();
}

browser.webRequest.onBeforeRequest.addListener(scriptListener, {
    // This is where script/subtitle assets are loaded from.
    urls: ["*://v.vrv.co/*"],
}, ["blocking"]);

browser.webRequest.onBeforeSendHeaders.addListener(playListener, {
    // This is where video metadata is loaded from.
    urls: ["*://cr-play-service.prd.crunchyrollsvc.com/v1/*/web/firefox/play"],
}, ["blocking", "requestHeaders"]);

console.info("Loaded");
