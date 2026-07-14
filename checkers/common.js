"use strict";

var CHF = CHF || {};

CHF.common = function () {
    function isNodeJs() {
        return typeof exports !== 'undefined';
    }
    var pub = isNodeJs() ? exports : {};
    pub.isNodeJs = isNodeJs;

    var nowProvider = isNodeJs() ? Date : window.performance;

    // A function replacement keeps "$&"-style patterns in values literal.
    function replaceToken(formatted, value) {
        return formatted.replace("{}", function () { return value; });
    }

    function format(formatted) {
        for (var i=1; i<arguments.length; i+=1) {
            formatted = replaceToken(formatted, arguments[i]);
        }
        return formatted;
    }
    pub.format = format;

    function log(formatted) {
        for (var i=1; i<arguments.length; i+=1) {
            formatted = replaceToken(formatted, autoScaleFormat(arguments[i]));
        }
        console.log(formatted);
    }
    pub.log = log;

    function coalesce(a, b) {
        if (a == null) return b;
        return a;
    }
    pub.coalesce = coalesce;

    function assert(condition, message) {
        if (!condition) {
            throw new Error("Assertion failed:  " + message);
        }
    }
    pub.assert = assert;

    function nowMs() {
        return nowProvider.now();
    }
    pub.nowMs = nowMs;

    function elapsedSec(startMs) {
        return (nowMs() - startMs) / 1000;
    }
    pub.elapsedSec = elapsedSec;

    function round(num, places) {
        places = places || 0;
        var scale = Math.pow(10, places);
        return Math.round(num * scale) / scale;
    }
    pub.round = round;

    function Random(seed) {
        this.x = seed || Math.floor(Math.random() * 1e9);
        this.y = 0;
        this.z = 0;
        this.w = 0;
        for (var k = 64; k > 0; --k) {
            this.next31();
        }
    }
    Random.prototype.next31 = function () {
        var t = this.x ^ (this.x << 11);
        this.x = this.y;
        this.y = this.z;
        this.z = this.w;
        return this.w ^= (this.w >> 19) ^ t ^ (t >> 8);
    };
    Random.prototype.int31array = function(length) {
        var array = [];
        for (var i=0; i<length; i++) {
            array.push(this.next31());
        }
        shuffle(array, this);
        return array;
    };
    Random.prototype.float = function () {
        return this.next31() / 2147483648;
    };
    Random.prototype.int = function (maxExclusive) {
        return Math.floor(maxExclusive * this.float());
    };
    pub.Random = Random;

    function formatNumber(number, length, decimals) {
        if (typeof number !== "number") return number;
        var rounded = round(number, decimals);
        var paddedRight = rounded.toString();
        if (paddedRight.indexOf("0.") === 0) {
            paddedRight = paddedRight.slice(1);
        }
        if (paddedRight.indexOf("-0.") === 0) {
            paddedRight = "-" + paddedRight.slice(2);
        }
        if (decimals > 0) {
            if (paddedRight.indexOf(".") === -1) {
                paddedRight += ".";
            }
            var existing = paddedRight.length - paddedRight.indexOf(".") - 1;
            if (decimals > existing) {
                paddedRight += new Array(decimals-existing+1).join("0");
            }
        }
        if (paddedRight.length >= length) {
            return paddedRight;
        }
        return (new Array(length+1).join(" ") + paddedRight).slice(-length);
    }
    pub.formatNumber = formatNumber;

    function autoScaleFormat(number) {
        if (typeof number !== 'number') return number;
        if (isNaN(number)) return " NaN";
        if (number === 0) return "   0";
        if (number < 0) {
            var magnitude = -number;
            if (magnitude < 0.005) return "-.00";
            if (magnitude < 1e0) return formatNumber(number, 4, 2);
            if (magnitude < 1e1) return formatNumber(number, 4, 1);
            if (magnitude < 1e2) return formatNumber(number, 4, 0);
            if (magnitude < 1e3) return formatNumber(number, 4, 0);
            if (magnitude < 1e4) return formatNumber(number/1e3, 3, 0) + "K";
            if (magnitude < 1e5) return formatNumber(number/1e3, 3, 0) + "K";
            if (magnitude < 1e6) return formatNumber(number/1e6, 3, 1) + "M";
            if (magnitude < 1e7) return formatNumber(number/1e6, 3, 0) + "M";
            return round(number/1e6, 0) + "M";
        } else {
            if (number < 0.0005) return ".000";
            if (number < 1e0) return formatNumber(number, 4, 3);
            if (number < 1e1) return formatNumber(number, 4, 2);
            if (number < 1e2) return formatNumber(number, 4, 1);
            if (number < 1e3) return formatNumber(number, 4, 0);
            if (number < 1e4) return formatNumber(number, 4, 0);
            if (number < 1e5) return formatNumber(number/1e3, 3, 0) + "K";
            if (number < 1e6) return formatNumber(number/1e3, 3, 0) + "K";
            if (number < 1e7) return formatNumber(number/1e6, 3, 1) + "M";
            if (number < 1e8) return formatNumber(number/1e6, 3, 0) + "M";
            return round(number/1e6, 0) + "M";
        }
    }
    //for (var num=0; num<2000000000; num=num*2+0.1) {
    //    log("{} == {}", -num, new String(-num));
    //}
    //log("");
    //for (var num=0; num<2000000000; num=num*2+0.1) {
    //    log("{} == {}", num, new String(num));
    //}
    pub.autoScaleFormat = autoScaleFormat;

    function shuffle(array, rand) {
        for (var i = array.length - 1; i > 0; i--) {
            var j = rand.int(i + 1);
            var temp = array[i];
            array[i] = array[j];
            array[j] = temp;
        }
        return array;
    }
    pub.shuffle = shuffle;

    // Returns the index of target, or ~insertionPoint (always negative) when
    // absent.  (~maxIndex would be 0 — indistinguishable from a match at
    // index 0 — whenever target is smaller than every element.)
    function binarySearch(array, target, arrayLength) {
        if (arrayLength == null) {
            arrayLength = array.length;
        }
        var minIndex = 0;
        var maxIndex = arrayLength - 1;
        var currentIndex, currentElement;
        while (minIndex <= maxIndex) {
            currentIndex = (minIndex + maxIndex) / 2 | 0;
            currentElement = array[currentIndex];
            if (currentElement < target) {
                minIndex = currentIndex + 1;
            }
            else if (currentElement > target) {
                maxIndex = currentIndex - 1;
            }
            else {
                return currentIndex;
            }
        }
        return ~minIndex;
    }
    pub.binarySearch = binarySearch;

    function padLeft(pad, str) {
        if (typeof str === 'undefined')
            return pad;
        return (pad + str).slice(-pad.length);
    }
    pub.padLeft = padLeft;
    function padRight(str, pad) {
        if (typeof str === 'undefined')
            return pad;
        return (str + pad).substring(0, pad.length);
    }
    pub.padRight = padRight;

    function IirFilter(decay, initialValue, initialWeight) {
        initialValue = initialValue || 0;
        if (initialValue || initialWeight) {
            initialWeight = initialWeight || 1;
        } else {
            initialWeight = 0;
        }
        var valueSum = initialValue * initialWeight;
        var weightSum = initialWeight;
        this.add = function (value, weight) {
            weight = weight || 1;
            valueSum = decay * valueSum + value;
            weightSum = decay * weightSum + weight;
        };
        this.value = function () {
            return valueSum / weightSum;
        };
    }
    pub.IirFilter = IirFilter;

    return pub;
}();
