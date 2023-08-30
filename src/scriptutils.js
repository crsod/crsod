// Utility functions for dealing with script/subtitle data.

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_SECOND = 1000;
const MS_PER_CENTISECOND = 10;


/**
 * @param {string} timestr Time string from script e.g. "0:04:08.01"
 * @returns {Number} timestr converted to milliseconds
 */
function script_parse_time(timestr) {
    let fields = timestr.split(':');
    let s_cs = fields[2].split('.');

    return (
        Number(fields[0]) * MS_PER_HOUR
        + Number(fields[1]) * MS_PER_MINUTE
        + Number(s_cs[0]) * MS_PER_SECOND
        + Number(s_cs[1]) * MS_PER_CENTISECOND
    );
}

/**
 * @param {number} timems Time in milliseconds
 * @returns {string} A time string in Dialogue format, e.g. "0:04:08.01"
 */
function script_render_time(timems) {
    var hours = 0;
    var minutes = 0;
    var seconds = 0;
    var centiseconds = 0;

    while (timems > MS_PER_HOUR) {
        hours += 1;
        timems -= MS_PER_HOUR;
    }
    while (timems > MS_PER_MINUTE) {
        minutes += 1;
        timems -= MS_PER_MINUTE;
    }
    while (timems > MS_PER_SECOND) {
        seconds += 1;
        timems -= MS_PER_SECOND;
    }
    while (timems > MS_PER_CENTISECOND) {
        centiseconds += 1;
        timems -= MS_PER_CENTISECOND;
    }

    let out_fields = [];
    out_fields.push(String(hours));
    out_fields.push(':')

    out_fields.push(String(minutes).padStart(2, '0'));
    out_fields.push(':')

    out_fields.push(String(seconds).padStart(2, '0'));
    out_fields.push('.')

    out_fields.push(String(centiseconds).padStart(2, '0'));

    return out_fields.join('');
}

/**
 * @param {string} text
 * @returns {string} A normalized form of dialogue text (for comparisons only) 
 */
function script_normalize(text) {
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    // Example:
    // {\i1}...leaving only my footprints behind.{\i0}
    // =>
    // leavingonlymyfootprintsbehind
    let out = '';
    for (var i = 0; i < text.length; ++i) {
        let ch = text[i];
        if (ch == '\\') {
            ++i;
            continue;
        }
        if (ch == '{') {
            while (i < text.length && text[i] != '}') {
                ++i;
            }
            continue;
        }
        if (CHARS.indexOf(ch) != -1) {
            out = out + ch;
        }
    }

    return out;
}

/**
 * Parse and return all Dialogue lines from a script, normalizing the text.
 * @param {string} script 
 */
function script_dialogue_lines(script) {
    let lines = script.split("\r\n").filter((s) => s.startsWith("Dialogue: "));
    return lines.map((line) => {
        let text = script_extract_text(line);
        let time = script_parse_time(line.split(',', 2)[1]);
        return { 'raw': line, 'text': script_normalize(text), 'time': time };
    })
}

/**
 * 
 * @param {string} line 
 */
function script_extract_text(line) {
    // Dialogue: 0,0:00:08.84,0:00:11.30,Default,,0000,0000,0000,,Foo, bar and baz
    for (var i = 0; i < 9; ++i) {
        let idx = line.indexOf(',');
        line = line.substring(idx + 1);
    }
    return line;
}

/**
 * Try to find a matching line of dialogue between two scripts.
 * @param {string} script1
 * @param {string} script2
 * @return {Array<string>|null} Two matching lines, or null if no match
 */
function script_match_text(script1, script2) {
    let dialog1 = script_dialogue_lines(script1);
    let dialog2 = script_dialogue_lines(script2);

    for (var i = 0; i < dialog1.length; ++i) {
        let line1 = dialog1[i];
        if (line1.text.length < 6) {
            // Too short for meaningful comparison
            continue;
        }
        for (var j = 0; j < dialog2.length; ++j) {
            let line2 = dialog2[j];
            if (line1.text == line2.text) {
                return [line1, line2];
            }
        }
    }
    return null;
}


/**
 * Try to find a timing adjustment which can cause two scripts to (fuzzily) match up.
 * @param {string} script1
 * @param {string} script2
 * @return {number|null} A duration in ms, or null if scripts can't be matched up.
 */
function script_timing_adjust(script1, script2) {
    let matched = script_match_text(script1, script2);
    console.debug("script match?", matched);
    if (!matched) {
        return null;
    }

    return matched[0].time - matched[1].time;
}
