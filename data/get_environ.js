
var environ = voodoo.ua();

console.log("Here here in get_environ: " + JSON.stringify(environ));
self.port.emit("got_environ", environ);