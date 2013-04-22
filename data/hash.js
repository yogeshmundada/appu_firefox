
// function my_log(msg, error) {
//     var ln = error.lineNumber;
//     var fn = error.fileName.split('->').slice(-1)[0].split('/').splice(-1)[0];
//     console.log(fn + "," + ln + ": " + msg);
// }

// function include_thirdparty(lib_name) {
//     const { Cc, Ci } = require("chrome");
    
//     var mozIJSSubScriptLoader = Cc["@mozilla.org/moz/jssubscript-loader;1"]
// 	.getService(Ci.mozIJSSubScriptLoader);

//     var lib_mod = {};
//     mozIJSSubScriptLoader.loadSubScript(data.url("thirdparty/" + lib_name), lib_mod);
//     return lib_mod;
// }

// //var sjcl = include_thirdparty("sjcl.js").sjcl;
// //var sjcl = importScripts("thirdparty/sjcl.js");

// function calculate_hash(pwd, limit) {
//     var st, et;
//     var rc = {};

//     st = new Date();

//     for (var i = 0; i < limit; i++) {
// 	k = sjcl.hash.sha256.hash(pwd);
// 	pwd = sjcl.codec.hex.fromBits(k);
//     }

//     et = new Date();

//     rc['hashed_pwd'] = pwd;
//     rc['count'] = i;
//     rc['time'] = (et - st)/1000;
//     return rc;
// }

self.postMessage("Invoked hashing worker");
self.onmessage = function(event) {
    //my_log("Here here: Answer is: ", new Error);
    var msg = event.data;
//     if (msg.cmd == "hash") {
// 	rc = calculate_hash(msg.pwd, msg.limit);
// 	rc['status'] = 'success';
//     }
//     else {
// 	rc['status'] = 'failure';
// 	rc['reason'] = "Wrong cmd: " + msg.cmd;
//     }
//    self.postMessage(rc);
    self.postMessage({
	    "hello" : "world"
	    
	});
    self.close();
};

//console.log("Here here: I AM IN THE HASH");