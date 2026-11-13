#!/bin/bash
# build-en.sh
set -e
for f in *.js; do
	awk -f translate.awk translations.txt "$f" > "../mp3-browser/${f}"
	echo "Translated: ${f}"
done