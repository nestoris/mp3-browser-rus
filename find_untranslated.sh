#!/bin/bash
awk -f find_untranslated.awk translations.txt *.js > untranslated.txt