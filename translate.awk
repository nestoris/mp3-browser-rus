#!/usr/bin/awk -f
# translate.awk — построчная замена русских строк на английские,
# сбор непереведённых фрагментов в untranslated.txt
# и отчёт о дубликатах русского ключа с разными переводами в dupes.txt.
#
# Использование:
#   awk -f translate.awk translations.txt file.js > file_en.js

BEGIN {
    trans_file = ARGV[1]
    delete ARGV[1]

    # ---------- Загрузка переводов + поиск дубликатов ----------
    n = 0
    rus = ""
    # first_en[ru] — первый (канонический) английский перевод
    # dupes_seen[ru SUBSEP en] — чтобы не считать один и тот же вариант дважды
    delete first_en
    delete dupes_seen

    while ((getline line < trans_file) > 0) {
        if (line == "") {
            rus = ""
            continue
        }
        if (rus == "") {
            rus = line
        } else {
            n++
            from[n] = rus
            to[n]   = line

            if (!(rus in first_en)) {
                first_en[rus] = line
                # Запоминаем порядок первого появления для dupes.txt
                order[++order_count] = rus
            } else if (first_en[rus] != line) {
                # Разные переводы одного ключа — фиксируем
                key = rus SUBSEP line
                if (!(key in dupes_seen)) {
                    dupes_seen[key] = 1
                    # Список вариантов для этого ключа
                    if (!(rus in dupes_list_count)) {
                        dupes_list_count[rus] = 0
                    }
                    dupes_list_count[rus]++
                    dupes_list[rus, dupes_list_count[rus]] = line
                }
            }
            rus = ""
        }
    }
    close(trans_file)

    # ---------- Сортировка по убыванию длины ----------
    # Заменяем по from/to, но для ключей с дубликатами
    # канонический перевод — first_en[from[i]].
    for (i = 1; i <= n; i++) {
        for (j = i + 1; j <= n; j++) {
            if (length(from[i]) < length(from[j])) {
                tmp = from[i]; from[i] = from[j]; from[j] = tmp
                tmp = to[i];   to[i]   = to[j];   to[j]   = tmp
            }
        }
    }

    # ---------- Выходной файл для непереведённого ----------
    untranslated_file = "untranslated.txt"
    printf "" > untranslated_file
    delete seen_untranslated

    # ---------- Отчёт о дубликатах ----------
    dupes_file = "dupes.txt"
    printf "" > dupes_file
    if (order_count > 0) {
        first_group = 1
        for (k = 1; k <= order_count; k++) {
            r = order[k]
            if (!(r in dupes_list_count)) continue

            if (!first_group) {
                # Между группами — ДВЕ пустые строки
                print "" >> dupes_file
                print "" >> dupes_file
            }
            first_group = 0

            # Внутри группы: русская строка и все английские варианты,
            # между парами — ОДНА пустая строка.
            # Формат «русская\nанглийская» повторяем для каждого варианта.
            for (v = 1; v <= dupes_list_count[r]; v++) {
                if (v > 1) print "" >> dupes_file
                print r >> dupes_file
                print dupes_list[r, v] >> dupes_file
            }
        }
    }
}

# Проверка на кириллицу (старшие байты UTF-8: 0xD0, 0xD1)
function has_cyrillic(s,    i, c) {
    for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (c == sprintf("%c", 208) || c == sprintf("%c", 209)) {
            return 1
        }
    }
    return 0
}

{
    line = $0

    # ---------- 1. Применяем переводы (первый вариант для каждого ключа) ----------
    for (i = 1; i <= n; i++) {
        if (index(line, from[i]) > 0) {
            repl = first_en[from[i]]   # всегда канонический вариант
            out = ""
            rest = line
            while ((pos = index(rest, from[i])) > 0) {
                out = out substr(rest, 1, pos - 1) repl
                rest = substr(rest, pos + length(from[i]))
            }
            line = out rest
        }
    }

    # ---------- 2. Сбор непереведённого ----------
    if (has_cyrillic(line)) {
        frag = line
        sub(/^[ \t]+/, "", frag)
        sub(/[ \t]+$/, "", frag)

        if (frag != "" && frag != "//" && frag !~ /^#!\/usr\/bin\/gjs$/) {
            if (!(frag in seen_untranslated)) {
                seen_untranslated[frag] = 1
                print frag >> untranslated_file
            }
        }
    }

    print line
}