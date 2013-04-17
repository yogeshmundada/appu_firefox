
function my_log(msg, error) {
    var ln = error.lineNumber;
    var fn = error.fileName.split('->').slice(-1)[0].split('/').splice(-1)[0];
    console.log(fn + "," + ln + ": " + msg);
}

var bg_response = undefined;

function read_minutes() {
    var minutes = parseFloat($('#input-minutes').val());
    if (minutes == NaN || (minutes % 1 != 0)) {
	my_log('Enter only valid minutes', new Error);
	$("#error-message").text('Please enter a valid number');
	$("#accept-minutes").addClass('error');
    }
    else {
	$("#accept-minutes").removeClass('error');
	message = {};
	message.type = "status_change";
	message.status = "disable";
	message.minutes = minutes;

	self.port.emit("status_change", message);
    }
    return false;
}

function disable() {
    //$('#sign-in-menu-list').hide();
    $('#sign-out-menu').dropdown('toggle');
    $('#enter-minutes').show();
    //$('body').css({'width': '220px', 'min-height': '100px'});
    $('#input-minutes').focus();
}

function enable() {
    message = {};
    message.type = "status_change";
    message.status = "enable";
    self.port.emit("status_change", message);
}

function report() {
    my_log("Here here: 'Check Report' was clicked on", new Error);
    self.port.emit("open-report");
}

function sign_in() {
    my_log("Here here: Sign-in was clicked on", new Error);
    self.port.emit("open-sign-in");
}

function sign_out() {
    my_log("Here here: Sign-out was clicked on", new Error);
    self.port.emit("sign-out");
}

function options() {
    my_log("Here here: 'Options' was clicked on", new Error);
    self.port.emit("open-options");
}

function footprint() {
    my_log("Here here: 'My Footprint' was clicked on", new Error);
    self.port.emit("open-myfootprint");
}

function about() {
    my_log("Here here: 'About' was clicked on", new Error);
    self.port.emit("open-about");
}

function send_feedback() {
    my_log("Here here: 'Send Feedback' was clicked on", new Error);
    self.port.emit("open-feedback");
}

function show_menu(response) {
    my_log("Here here: show_menu(): " + response.status, new Error);

    if (response.status == "not-signed-in") {
	$('#sign-in-menu').dropdown('toggle');

	m = {
	    height : $('#sign-in-menu-list').height(),
	    width: $('#sign-in-menu-list').width()
	}

	self.port.emit("displayed", m);
    }
    if (response.status == "signed-in") {
	$('#login-name').html(" " + response.login_name);
	$('body').css('background-color', 'green');

	$('#sign-out-menu').dropdown('toggle');

	$('#sign-out-menu-list').css("margin-top", "-340px");
	$('#sign-out-menu').css("background-color", "orange");

	m = {
	    height : $('#sign-out-menu-list').height(),
	    width: $('#sign-out-menu-list').width()
	}

	self.port.emit("displayed", m);

	bg_response = response;
	if (bg_response.appu_status == 'disabled') {
	    $("#appu-signedin-menu-icon").attr("src", "images/appu_new19_offline.png");
	}
    }
}

function hook_ups() {
    $("#disable").on("click", function() { disable();});
    $('#disable-submit').on('click', read_minutes);

    $("#enable").on("click", enable);
    $("#report").on("click", report); 
    $("#options").on("click", options) 
    $("#footprint").on("click", footprint); 
    $("#about").on("click", about); 
    $("#feedback").on("click", send_feedback); 

    $("#sign-in").on("click", sign_in); 
    $("#sign-out").on("click", sign_out); 
}


self.port.on("resized", function() {
	//my_log("Here here: Panel resized, isShowing: " + self.isShowing123);
	//my_log("Here here: Panel resized, height: " + $('body').height() + ", width: " + $('body').height());
    });


function activate_menu() {
	$('#disable').tooltip({
		'title' : 'Disable Appu across all tabs',
		    'placement' : 'up',
		    'delay': { 'show': 500, 'hide': 0 },
		    });
	
	$('#enable').tooltip({
		'title' : 'Enable Appu across all tabs',
		    'placement' : 'up',
		    'delay': { 'show': 500, 'hide': 0 },
		    });
	
	$('#enter-minutes').hide();

	my_log("Here here: Sending message to query signin-status", new Error);
	self.port.emit("get-signin-status", {
		'type' : 'get-signin-status',
		    });
	
	$('body').css({'max-width': '200px', 'max-height': '200px'});
}


function register_message_listeners() {
    self.port.on("menu-active", activate_menu);
    self.port.on("signin-status-response", show_menu);
}

register_message_listeners();
hook_ups();