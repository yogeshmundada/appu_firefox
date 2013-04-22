
function my_log(msg, error) {
    var ln = error.lineNumber;
    var fn = error.fileName.split('->').slice(-1)[0].split('/').splice(-1)[0];
    console.log(fn + "," + ln + ": " + msg);
}

// var w = undefined;
// w = new Worker("resource://jid1-c2fwybmljxxbtg-at-jetpack/appu_new/data/hash.js");
// //w = new Worker("hash.js");

// my_log("Here here: what is w?" + w, new Error);


// d1 = new Date();
// d2 = d1 + (2 * 60 * 1000);

// for(;;) {
//     var k = new Date();
//     if (k > d2) {
// 	break;
//     }
// }

my_log("Here here: Finished the infinite loop", new Error);

