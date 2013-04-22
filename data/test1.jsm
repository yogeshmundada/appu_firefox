
function my_log(msg, error) {
    var ln = error.lineNumber;
    var fn = error.fileName.split('->').slice(-1)[0].split('/').splice(-1)[0];
    console.log(fn + "," + ln + ": " + msg);
}

var w = undefined;
w = new ChromeWorker("resource://jid1-c2fwybmljxxbtg-at-jetpack/appu_new/data/");

my_log("Here here: what is w?" + w, new Error);
