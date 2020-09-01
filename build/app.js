"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var express = require("express");
var port = process.env.PORT || 5000;
var app = express();
app.get('/', function (req, res) {
    console.log('request received');
    res.json({ 'hello': 'hi' });
});
app.listen(port, function () { return console.log("Listening on " + port + " \u2728"); });
