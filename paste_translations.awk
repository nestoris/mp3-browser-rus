#!/usr/bin/awk -f
# Использование: awk -f paste_translations.awk untranslated.txt translated.txt > new_pairs.txt

BEGIN {
    ru_file = ARGV[1]
    en_file = ARGV[2]
    delete ARGV[1]
    delete ARGV[2]
    
    # Читаем первый файл (русский)
    n_ru = 0
    while ((getline line < ru_file) > 0) {
        if (line != "") {
            n_ru++
            ru[n_ru] = line
        }
    }
    close(ru_file)
    
    # Читаем второй файл (английский)
    n_en = 0
    while ((getline line < en_file) > 0) {
        if (line != "") {
            n_en++
            en[n_en] = line
        }
    }
    close(en_file)
    
    # Выводим парами: русская, английская, пустая
    max = (n_ru > n_en) ? n_ru : n_en
    for (i = 1; i <= max; i++) {
        if (i <= n_ru) print ru[i]
        if (i <= n_en) print en[i]
        print ""
    }
}