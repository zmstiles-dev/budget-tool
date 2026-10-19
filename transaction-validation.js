/* Pure intake validation; never reads or writes accepted application state. */
(function (root) {
    'use strict';
    function date(value) {
        const text = String(value ?? '').trim();
        let year, month, day;
        let match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
        if (match) {
            [, month, day, year] = match;
            if (year.length === 2) year = '20' + year;
        } else {
            match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
            if (!match) return '';
            [, year, month, day] = match;
        }
        const check = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
        if (check.getUTCFullYear() !== Number(year) || check.getUTCMonth() + 1 !== Number(month) || check.getUTCDate() !== Number(day)) return '';
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    function minorUnits(value) {
        let text = String(value ?? '').trim();
        const parentheses = /^\(.*\)$/.test(text);
        if (parentheses) text = text.slice(1, -1);
        // Allow ordinary currency formatting, but never partial parse or silent zero.
        if (!/^-?\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return NaN;
        if (parentheses && text.startsWith('-')) return NaN;
        const negative = text.startsWith('-');
        const unsigned = text.replace(/^-/, '').replace(/[$,]/g, '');
        const [whole, fraction = ''] = unsigned.split('.');
        try {
            const cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
            const signed = (negative || parentheses) ? -cents : cents;
            if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) return NaN;
            return Number(signed);
        } catch (_) {
            return NaN;
        }
    }
    function split(amount, parts) {
        const original = minorUnits(amount);
        const cents = parts.map(minorUnits);
        if (!Number.isSafeInteger(original) || !cents.length || cents.some(c => !Number.isSafeInteger(c) || c <= 0) || cents.reduce((sum, c) => sum + c, 0) !== Math.abs(original)) {
            throw new Error('Positive split amounts must exactly equal the source amount.');
        }
        return cents.map(c => Math.sign(original) * c / 100);
    }
    const api = Object.freeze({ date, minorUnits, split });
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TransactionValidation = api;
})(typeof globalThis === 'undefined' ? this : globalThis);
