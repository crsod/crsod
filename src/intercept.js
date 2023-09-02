// Functionality common to all interceptors.


/**
 * An interceptor for a single request in progress (base class).
 */
class Interceptor {
    static ENCODER = new TextEncoder();
    static DECODER = new TextDecoder("utf-8");

    constructor(request) {
        this._request = request;
        this._filter = browser.webRequest.filterResponseData(request.requestId);
        this._filter.ondata = (event) => { this.ondata(event) };
        this._filter.onstop = (event) => { this.onstop() };
        this._filter.onerror = (event) => { this.onerror(this._filter.error) };
        this._buf = '';
    }

    onerror(error) {
        console.error("Aborting filter due to error", error);
        this._filter.disconnect();
    }

    ondata(event) {
        let str = Interceptor.DECODER.decode(event.data, { "stream": true });
        this._buf = this._buf + str;
    }

    onstop() {
        if (this._buf === '') {
            // No response data (but also no error).
            //
            // This seems to happen for "raced" requests where FF does a request
            // both from cache and from the server. The slower request ends up
            // discarded and this seems to manifest as an empty response body here.
            this._filter.disconnect();
            return;
        }

        this.oncomplete(this._buf).then(
            (body) => {
                this._filter.write(Interceptor.ENCODER.encode(body));
                this._filter.disconnect();
            }
        ).catch((error) => this.onerror(error))
    }

    /**
     * @returns {string} URL of request being intercepted.
     */
    url() {
        return this._request.url;
    }

    /**
     * Handler invoked at completion of intercepted request.
     *
     * Intended to be overridden by subclasses.
     * 
     * @param {string} body Response body
     * @returns {Promise<string>} Replacement for response body
     */
    async oncomplete(body) {
        return body;
    }
}
