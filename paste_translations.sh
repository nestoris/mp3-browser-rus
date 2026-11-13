#!/bin/bash

awk -f paste_translations.awk untranslated.txt translated.txt > new_pairs.txt