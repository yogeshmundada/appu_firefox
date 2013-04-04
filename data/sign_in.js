
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
    if (username != '' && password != '') {
	chrome.extension.sendMessage("", {
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
	    chrome.extension.sendMessage("", {
		'type' : 'create-account',
		'username' : username,
		'password' : password,
	    });
	}
	else {
	    $("#top-status").addClass("text-error");
	    $("#top-status").text("Password and Confirm-password does not match");
	}
    }
    else {
	$("#top-status").addClass("text-error");
	$("#top-status").text("Username or Password empty");
    }
}

function handle_account_failure() {
	$("#top-status").addClass("text-error");
	$("#top-status").text(message.desc);
}

function handle_account_success() {
    $(".login-form").hide();
    $(".create-account-form").hide();
    $("#username-info").hide();
    $("#top-status").removeClass("text-error");
    $("#top-status").addClass("text-success");
    $("#top-status").text(message.desc);
}

function handle_login_failure() {
    $("#top-status").addClass("text-error");
    $("#top-status").text(message.desc);
}

function handle_login_success() {
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
}

document.addEventListener('DOMContentLoaded', function () {
	console.log("Here here: In sign_in.js, domcontentloaded event");
	$("#login-submit").on("click", login);
	$('#create-account-submit').on('click', create_account);
	$('body .login-form').on('keypress', 'input:password, input:text', 
				 {'type': 'login'}, check_for_enter);
	$('body .create-account-form').on('keypress', 'input:password, input:text', 
					  {'type': 'create-account'}, check_for_enter);
});

register_message_listeners();

self.port.emit('get-version');
self.port.emit('get-signin-status');
