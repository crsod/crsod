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
// TODO: something better. There's probably no single threshold which can work
// for all media...
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
     */
    set_subs(lang, obj) {
        this._raw['subtitles'][lang] = obj;
    }

    /**
     * @returns URL of subtitle asset for 'lang', or null.
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
            return true;
        }

        // There are subs, but they might be crap, let's fetch and see.
        console.debug("Fetching sub asset:", sub_url);
        let assetResponse = await fetch(sub_url);
        let assetText = await assetResponse.text();
        let assetLength = assetText.length;

        // The subs are assumed to be good only if the size is above the threshold.
        if (assetLength > THRESHOLD) {
            console.info(`Not replacing subs for ${guid} as sub asset length of ${assetLength} exceeds threshold`);
            return false;
        }
        console.info(`Replacing subs for ${guid} from ${alt_guid} as sub asset length of ${assetLength} is below threshold`);
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
        let intercept = this;
        this.filter.ondata = (event) => { intercept.ondata(event).catch((error) => this.onerror(error)) };
        this.filter.onstop = (event) => { intercept.onstop() };
        // TODO: onerror
        console.debug("started intercept", this.filter);
    }

    onstop() {
        this.buf = this.adjust_times(this.buf);
        console.debug("Rewritten script", this.buf);
        this.filter.write(ENCODER.encode(this.buf));
        this.filter.disconnect();

        console.info(`Script times adjusted by ${this.adjust}ms`);
    }

    /**
     * 
     * @param {string} script 
     * @returns 
     */
    adjust_times(script) {
        if (!this.format_ok(script)) {
            console.warn("Unexpected script format, cannot adjust timing");
            return script;
        }

        return script.split("\r\n").map((line) => this.adjust_line(line)).join("\r\n");
    }

    /**
     * 
     * @param {string} line 
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
     * 
     * @param {string} str 
     */
    adjust_timestr(str) {
        // 0:04:08.01
        let fields = str.split(':');
        let s_cs = fields[2].split('.');
        const MS_PER_HOUR = 60 * 60 * 1000;
        const MS_PER_MINUTE = 60 * 1000;
        const MS_PER_SECOND = 1000;
        const MS_PER_CENTISECOND = 10;

        let original_ms = (
            Number(fields[0]) * MS_PER_HOUR
            + Number(fields[1]) * MS_PER_MINUTE
            + Number(s_cs[0]) * MS_PER_SECOND
            + Number(s_cs[1]) * MS_PER_CENTISECOND
        );
        // console.debug("time ms:", str, original_ms);

        var new_ms = original_ms + this.adjust;
        var hours = 0;
        var minutes = 0;
        var seconds = 0;
        var centiseconds = 0;

        while (new_ms > MS_PER_HOUR) {
            hours += 1;
            new_ms -= MS_PER_HOUR;
        }
        while (new_ms > MS_PER_MINUTE) {
            minutes += 1;
            new_ms -= MS_PER_MINUTE;
        }
        while (new_ms > MS_PER_SECOND) {
            seconds += 1;
            new_ms -= MS_PER_SECOND;
        }
        while (new_ms > MS_PER_CENTISECOND) {
            centiseconds += 1;
            new_ms -= MS_PER_CENTISECOND;
        }

        let out_fields = [];
        out_fields.push(String(hours));
        out_fields.push(':')

        out_fields.push(String(minutes).padStart(2, '0'));
        out_fields.push(':')

        out_fields.push(String(seconds).padStart(2, '0'));
        out_fields.push('.')

        out_fields.push(String(centiseconds).padStart(2, '0'));

        let out = out_fields.join('');
        // console.debug("Adjusted time", str, out);
        return out;
    }

    format_ok(script) {
        let idx = script.indexOf("Format: Layer,Start,End,");
        return (idx != -1);
    }

    onerror(error) {
        console.error("Aborting filter due to error", error);
        this.filter.disconnect();
    }

    async ondata(event) {
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
        let intercept = this;
        this.filter.ondata = (event) => { intercept.ondata(event).catch((error) => this.onerror(error)) };
        // TODO: onerror
        console.debug("started intercept", this.filter);
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
        console.debug("should adjust times by", duration_adjust);

        console.debug("request obj", this.originalRequest);
        let response = await fetch(altUrl, { "headers": this.headers() });
        let responseJson = await response.json();
        console.debug("Sub response:", responseJson);

        let altsub = responseJson.subtitles[DUB_LANG];

        if (altsub.format == "ass") {
            let altsub_url = altsub.url;
            TIMING_ADJUST[altsub_url] = duration_adjust;
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
}

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



function playListener(request) {
    console.debug(`Loading (play): ${request.url}`);

    let filter = browser.webRequest.filterResponseData(request.requestId);
    let intercept = new PlayInterceptor(filter, request);
    intercept.start();
}

browser.webRequest.onBeforeRequest.addListener(scriptListener, {
    urls: ["*://v.vrv.co/*"],
}, ["blocking"]);

browser.webRequest.onBeforeSendHeaders.addListener(playListener, {
    urls: ["*://cr-play-service.prd.crunchyrollsvc.com/v1/*/web/firefox/play"],
}, ["blocking", "requestHeaders"]);

console.info("Loaded");
