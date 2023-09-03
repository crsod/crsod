// Language for alternative subs (i.e. the media version from which subs are loaded,
// NOT the language used within the subs).
//
// TODO: this should possibly be taken from the media version advertised as
// "original": true in the API since there's a handful of media for which Japanese
// isn't the original language. On the other hand, I'm paranoid there may be some
// videos with that attribute set incorrectly.
const ALT_LANG = 'ja-JP';

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
const SCRIPT_EMPTY_THRESHOLD = 7500;


// Wrapper for response from '/play' endpoint
class PlayResponse {
    constructor(raw) {
        this._raw = raw;
    }

    /**
     * @returns {string} the audio language for this video
     */
    audio_lang() {
        return this._raw.audioLocale;
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
     * @param {Promise<string|null>} dub_script Promise for dub script contents
     * @returns {Promise<boolean>} True if subs matching the dub's language should be replaced.
     * This is true in the (very common) case where e.g. an English video advertises that
     * English subs are available, but the subs are virtually empty.
     */
    async should_replace_dub_sub(dub_script) {
        let guid = this.guid();
        let alt_guid = this.alt_guid();
        let dub_lang = this.audio_lang();

        let script_text = await dub_script;
        if (script_text === null) {
            // There are no subs for the desired lang, so we ought to fetch some.
            console.info(`${guid}: replacing ${dub_lang} subs from ${alt_guid} as subs are missing entirely`);
            return true;
        }

        // There are subs, but are they any good?
        if (script_text.length > SCRIPT_EMPTY_THRESHOLD) {
            console.info(`${guid}: not replacing ${dub_lang} subs as script length of ${script_text.length} exceeds threshold`);
            return false;
        }
        console.info(`${guid}: replacing ${dub_lang} subs from ${alt_guid} as script length of ${script_text.length} is below threshold`);
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
 * An interceptor for a single /play request in progress.
 */
class PlayInterceptor extends Interceptor {
    constructor(request) {
        super(request);
        // Headers used for later requests to be authenticated correctly.
        this.headers = new Headers(request.requestHeaders.map((x) => [x['name'], x['value']]))
    }

    /**
     * @param {string} guid GUID of any media object.
     * @returns {Promise<number>} Duration (ms) of a media object with given GUID.
     */
    async media_duration(guid) {
        let url = `https://www.crunchyroll.com/content/v2/cms/objects/${guid}`;
        let opts = { "headers": this.headers };
        const response = await fetch(url, opts);
        const meta = await response.json();
        let out = meta.data[0].episode_metadata.duration_ms;
        console.debug(`${guid} duration: ${out}ms`);
        return out;
    }

    async oncomplete(body) {
        let media = new PlayResponse(JSON.parse(body));
        let guid = media.guid();
        let alt_guid = media.alt_guid();

        if (guid == alt_guid) {
            // We're loading the japanese, nothing to be done.
            return body;
        }

        let dub_lang = media.audio_lang();

        let dubUrl = this.url();
        let altUrl = dubUrl.replace(guid, alt_guid);
        console.debug("Watching dub", guid, "loading subs from", alt_guid, "via", altUrl);

        let response = await fetch(altUrl, { "headers": this.headers });
        let responseJson = await response.json();

        // Make a copy of original subs before we start messing with them.
        let subs = {};
        Object.assign(subs, media._raw.subtitles);

        let alt_subs = responseJson.subtitles;

        // Regardless of the user's selected subtitle language we are always going to
        // need the script for the current audio language from both the media and
        // alt_media, for purposes of timing sync. We might *also* need these scripts
        // later if these are what the user wants to display. So we start these fetches
        // early and keep around the promises for repeated reuse.
        var dub_fetch = Promise.resolve(null);
        var dub_alt_fetch = Promise.resolve(null);
        if (subs.hasOwnProperty(dub_lang)) {
            let url = subs[dub_lang].url;
            dub_fetch = fetch(url, { 'headers': this.headers }).then((response) => response.text());
        }
        if (alt_subs.hasOwnProperty(dub_lang)) {
            let url = alt_subs[dub_lang].url;
            dub_alt_fetch = fetch(url, { 'headers': this.headers }).then((response) => response.text());
            // Going to await this now because we will set up an intercept for this and we want to
            // be sure that the fetch happens before that.
            await dub_alt_fetch;
        }

        // These will also always be needed.
        let duration = this.media_duration(guid);
        let alt_duration = this.media_duration(alt_guid);

        let should_replace_sub = await media.should_replace_dub_sub(dub_fetch);
        let copied = [];

        Object.keys(alt_subs).filter((k) => alt_subs.hasOwnProperty(k)).forEach((lang) => {
            let alt_sub = alt_subs[lang];
            var copy_sub = false;

            // If dub lang already exists, it should be replaced only if should_replace_sub says
            // so (e.g. because the dub subs are bad/empty) 
            if (lang === dub_lang && Object.hasOwnProperty(subs, lang) && should_replace_sub) {
                console.debug(`${guid}: replacing subs for dub lang ${lang}`)
                copy_sub = true;
            }

            // Anything missing will be copied over. This might include the dub_lang for
            // dubs with no subs whatsoever.
            if (!Object.hasOwnProperty(subs, lang)) {
                console.debug(`${guid}: copying subs for missing lang ${lang}`)
                copy_sub = true;
            }

            if (copy_sub) {
                copied.push(lang);
                media.set_subs(lang, alt_sub);
                // Set up for timing adjustment.
                let ctx = new ScriptRewriteContext(
                    alt_sub.url,
                    media,
                    lang,
                    duration,
                    alt_duration,
                    dub_fetch,
                    dub_alt_fetch,
                    subs,
                    alt_subs,
                );
                ScriptInterceptor.register(ctx);
            }
        });

        copied.sort();
        console.info(`${guid}: added/replaced subs: ${copied.join(', ')}`)

        let rewrote = media.as_json();
        console.debug("Rewritten media:", rewrote);
        return rewrote;
    }
}

/**
 * Listener for requests to the /play endpoint.
 *
 * Filters and rewrites responses to add missing subtitle metadata.
 */
function playListener(request) {
    console.debug(`Loading (play): ${request.url}`);
    new PlayInterceptor(request);
}

browser.webRequest.onBeforeSendHeaders.addListener(playListener, {
    // This is where video metadata is loaded from.
    urls: ["*://cr-play-service.prd.crunchyrollsvc.com/v1/*/web/firefox/play"],
}, ["blocking", "requestHeaders"]);

console.info("Ready to intercept requests");
