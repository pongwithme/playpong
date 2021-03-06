var io = require('socket.io'),
    path = require('path'),
    nconf = require('nconf'),
    fs = require('fs'),
    express = require('express'),
    http = require('http');

function cleanArray(actual) {
    var i, newArray = [];

    for (i = 0; i < actual.length; i++) {
        if (typeof actual[i] !== 'undefined') {
            newArray.push(actual[i]);
        }
    }

    return newArray;
}

// load config from argv/environment variables/config.json
nconf.argv()
     .env()
     .file({file: path.resolve(__dirname, '../config/config.json')});

// express app
var app = express();

app.get("/config.js", function (req, res) {
    fs.readFile(path.resolve(__dirname, '../config/config.json'), function (err, data) {
        if (err) {
            throw err;
        }

        data = JSON.parse(data);
        // for security measures, set the params from config.json explicitly.
        data = {
            domain: data.domain,
            winning_score: data.winning_score
        };

        res.header("Content-Type", "text/javascript");
        res.send("CONFIG = " + JSON.stringify(data) + ";");
    });
});

app.use("/remote_control", express.static(path.resolve(__dirname, '../static/remote_control')));
app.use("/field", express.static(path.resolve(__dirname, '../static/field')));
app.use("/libs", express.static(path.resolve(__dirname, '../static/libs')));

// /(remote_control|field) -> /$1/ (add trailing slash, keep get params)
app.get(/^\/(remote_control|field)$/, function (req, res) {
    res.redirect(303, req.path + '/' + req.originalUrl.replace(/[^?]*/, ""));
});

// shortcuts / -> /field/
app.get(/^\/?$/, function (req, res) {
    res.redirect(302, '/field/');
});

// shortcuts /r/ -> /remote_control/?field_id={field_id}
app.get(/^\/r\/(\d*)\/?$/, function (req, res) {
    res.redirect(302, '/remote_control/?field_id=' + req.route.params[0]);
});

var port = process.env.PORT || nconf.get("port");
var http_server = app.listen(port);

// socket.io
io = io.listen(http_server);
io.set("log level", nconf.get("socket_io_log_level"));

var fields = [],
    controllers = {};

var for_each_controller = function (field_id, cb, done_cb) {
        if (typeof controllers[field_id] !== 'undefined') {
            var i;
            for (i = 0; i < controllers[field_id].length; i++) {
                var field_controller = controllers[field_id][i];
            
                if (typeof field_controller !== 'undefined') {
                    cb(field_controller, i); // cb(field_controller, controller_id);
                }
            }

            if (typeof done_cb !== 'undefined') {
                done_cb();
            }
        }
    },
    broadcast_to_controllers = function (field_id, event, event_args) {
        for_each_controller(field_id, function (field_controller) {
            field_controller.socket.emit(event, event_args);
        });
    },
    getFieldSocket = function (socket, field_id, disconnect_socket_if_not_found) {
        if (typeof disconnect_socket_if_not_found === 'undefined') {
            disconnect_socket_if_not_found = true;
        }

        var field_socket = fields[field_id];
        if (typeof field_socket === 'undefined') {
            if (disconnect_socket_if_not_found === true) {
                socket.disconnect();
            }

            return false;
        }

        return field_socket;
    },
    removeController = function (field_id, controller_id, socket, disconnect_controller) {
        if (typeof disconnect_controller === 'undefined') {
            disconnect_controller = true;
        }

        var field_socket = getFieldSocket(socket, field_id, false);
        if (field_socket === false) {
            return;
        }

        if (typeof controllers[field_id] === 'object') {
            if (typeof controllers[field_id][controller_id] === 'object') {
                if (disconnect_controller === true) {
                    controllers[field_id][controller_id].socket.disconnect();
                }

                delete controllers[field_id][controller_id];

                io.log.debug("controller disconnected and removed: " + controller_id + "; field_id: " + field_id);
            }
        }
    };
io.of("/agent")
    .on('connection', function (socket) {
        socket.on('new_field', function () {
            var self = this;

            var field_id = fields.push(socket) - 1;
            controllers[field_id] = [];
            socket.set("field_id", field_id);
            socket.set("status", "open");

            io.log.debug("new_field: " + field_id);

            socket.emit("field_registered", field_id);

            socket.on("disconnect", function () {
                io.log.debug("field disconnected: " + field_id);

                io.log.debug("field deleted: " + field_id);
                delete fields[field_id];

                broadcast_to_controllers(field_id, "error", {error: "Field disconnected", code: "field_disconnected"});
                for_each_controller(field_id, function (field_controller) {
                    field_controller.socket.disconnect();
                });

                io.log.debug("field's controllers disconnected and removed: " + field_id);
                delete controllers[field_id];
            });
        });

        socket.on('start', function (type) {
            var self = this;

            if (type !== 1 && type !== 2) {
                type = 1;
            }

            socket.set("left_paddle_direction", 0);
            socket.set("right_paddle_direction", 0);

            socket.set("game_type", type);

            socket.get("field_id", function (err, field_id) {
                var i = 0;
                for_each_controller(field_id, function (field_controller) {
                    var side = i++ % type;
                    field_controller.socket.emit("start", side);
                    field_controller.side = side;
                });
            });

            socket.set("status", "closed");
        });

        socket.on('new_controller', function (field_id) {
            var self = this;

            var field_socket = getFieldSocket(socket, field_id);
            if (field_socket === false) {
                socket.emit("error", {error: "Field does not exist", code: "field_not_exists"});

                return;
            }

            field_socket.get("status", function (err, status) {
                if (status !== "open") {
                    socket.emit("error", {error: "Field closed for registration", code: "field_closed_for_registration"});
                    socket.disconnect();

                    return;
                }

                var controller_id = controllers[field_id].push({socket: socket, side: null, direction: 0}) - 1;

                io.log.debug("new_controller registered on field: " + field_id + "; controller_id: " + controller_id);

                socket.emit("controller_registered", controller_id);
                field_socket.emit("controller_connected");

                socket.on("disconnect", function () {
                    removeController(field_id, controller_id, socket, false);

                    field_socket.emit("controller_disconnected");
                });
            });
        });

        socket.on('win', function (field_id, side) {
            io.log.debug("Round end on field: " + field_id + "; Winning side: " + side);

            var field_socket = getFieldSocket(socket, field_id);
            if (field_socket === false) {
                return;
            }

            var controllers_left_in_field = [];
            for_each_controller(field_id,
                function (field_controller, controller_id) {
                    if (field_controller.side === side) {
                        field_controller.socket.emit("round_end", true);

                        controllers_left_in_field.push(field_controller);
                    } else {
                        field_controller.socket.emit("round_end", false);

                        removeController(field_id, controller_id, socket);
                    }
                }, function () {
                    if (controllers_left_in_field.length === 1) {
                        field_socket.emit("winner");
                        controllers_left_in_field[0].socket.emit("winner");
                    }
                }
            );

        });

        socket.on('direction', function (field_id, controller_id, side, controller_direction) {
            var field_socket = getFieldSocket(socket, field_id);
            if (field_socket === false) {
                return;
            }

            if (typeof controllers[field_id][controller_id] === 'undefined') {
                return;
            }

            controllers[field_id][controller_id].direction = controller_direction;

            var controllers_directions = cleanArray(controllers[field_id].map(function (controller) {
                if (typeof controller === 'undefined') {
                    return undefined;
                }

                if (controller.side !== side) {
                    return undefined;
                }

                return controller.direction;
            }));

            var direction = controllers_directions.reduce(function (a, b) { return a + b; }, 0) / controllers_directions.length;
            if (direction > 0) {
                direction = 1;
            }

            if (direction < 0) {
                direction = -1;
            }

            field_socket.emit("direction", side, direction);
        });
    });