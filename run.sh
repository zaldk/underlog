#!/usr/bin/env bash

mkdir -p ./db/
wgo -file=.html -file=.css -file=.js -file=.go clear :: go run .
