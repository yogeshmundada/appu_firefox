"use strict";

var data = require("sdk/self").data;

var tld = require('./lib/tld.js').init();

var rules_json = data.load('rules.json');
tld.rules = JSON.parse(rules_json);

module.exports = tld;