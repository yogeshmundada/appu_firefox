
function my_log(msg, error) {
    var ln = error.lineNumber;
    var fn = error.fileName.split('->').slice(-1)[0].split('/').splice(-1)[0];
    console.log(fn + "," + ln + ": " + msg);
}


function check_for_enter(e) {
    if (e.which == 13) {
	if (e.data.type == 'login') {
	    login();
	}
	else if (e.data.type == 'create-account') {
	    create_account();
	}
    }
}

function handle_current_user(response) {
    my_log("Here here: In handling current USER", new Error);
    if (response.login_name != "default") {
	$(".login-form").hide();
	$(".create-account-form").hide();
	$("#username-info").hide();
	$("#top-status").addClass("text-error");
	$("#top-status").text("You are already logged-in as '" + response.login_name + 
			      "'. First sign out from menu.");
    }
}

function show_version(response) {
    $('#version-info').text(response.version);
}

function login() {
    var username = $.trim($("#login-username").val());
    var password = $.trim($("#login-password").val());

    my_log("Here here: Login is called", new Error);

    if (username != '' && password != '') {
	self.port.emit('sign-in',  {
	    'type' : 'sign-in',
	    'username' : username,
	    'password' : password,
		});
    }
    else {
	$("#top-status").addClass("text-error");
	$("#top-status").text('Username or Password is empty');
    }
}

function create_account() {
    var username = $("#ca-username").val();
    var password = $("#ca-password").val();
    var confirm_password = $("#ca-confirm-password").val();

    if (username != '' && password != '') {
	if (password == confirm_password) {
	    self.port.emit('create-account',  {
		    'type' : 'create-account',
			'username' : username,
			'password' : password,
			});
	}
	else {
	    $("#top-status").addClass("text-error");
	    $("#top-status").text("Password and Confirm-password do not match");
	}
    }
    else {
	$("#top-status").addClass("text-error");
	$("#top-status").text("Username or Password empty");
    }
}

function handle_account_failure(message) {
	$("#top-status").addClass("text-error");
	$("#top-status").text(message.desc);
}

function handle_account_success(message) {
    $(".login-form").hide();
    $(".create-account-form").hide();
    $("#username-info").hide();
    $("#top-status").removeClass("text-error");
    $("#top-status").addClass("text-success");
    $("#top-status").text(message.desc);
}

function handle_login_failure(message) {
    $("#top-status").addClass("text-error");
    $("#top-status").text(message.desc);
}

function handle_login_success(message) {
    $(".login-form").hide();
    $(".create-account-form").hide();
    $("#username-info").hide();
    $("#top-status").removeClass("text-error");
    $("#top-status").addClass("text-success");
    $("#top-status").text(message.desc);
}

function register_message_listeners() {
    self.port.on("get-version-response", show_version);
    self.port.on("get-signin-status-response", handle_current_user);

    self.port.on("login-success", handle_login_success);
    self.port.on("login-failure", handle_login_failure);

    self.port.on("account-success", handle_account_success);
    self.port.on("account-failure", handle_account_failure);

    my_log("Here here: Registered handle_sign_in_document_ready", new Error);
    self.port.on("sign-in-document-ready", handle_sign_in_document_ready);

    self.port.on("this-is-my-test-message", function() {
	    my_log("Here here: SUCCESS, received this-is-my-test-message", new Error);
	});
}

function handle_sign_in_document_ready() {
	$("#login-submit").on("click", login);
	$('#create-account-submit').on('click', create_account);
	$('body .login-form').on('keypress', 'input:password, input:text', 
				 {'type': 'login'}, check_for_enter);
	$('body .create-account-form').on('keypress', 'input:password, input:text', 
					  {'type': 'create-account'}, check_for_enter);
}

register_message_listeners();
handle_sign_in_document_ready();

self.port.emit('get-version');
self.port.emit('get-signin-status');
