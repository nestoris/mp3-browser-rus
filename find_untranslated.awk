#!/usr/bin/awk -f
# find_untranslated.awk — находит в .js-файлах кириллические строки,
# которые не будут полностью переведены translate.awk с текущей translations.txt.
# Выводит их без номеров строк, разделяя пустой строкой, без дубликатов.
#
# Использование:
#   awk -f find_untranslated.awk translations.txt *.js > untranslated.txt

BEGIN {
    trans_file = ARGV[1]
    delete ARGV[1]

    n = 0
    rus = ""
    while ((getline line < trans_file) > 0) {
        if (line == "") { rus = ""; continue }
        if (rus == "") {
            rus = line
        } else {
            n++
            from[n] = rus
            to[n]   = line
            rus = ""
        }
    }
    close(trans_file)

    # Сортировка по убыванию длины «from», как в translate.awk —
    # чтобы длинные фразы заменялись раньше коротких.
    for (i = 1; i <= n; i++)
        for (j = i + 1; j <= n; j++)
            if (length(from[i]) < length(from[j])) {
                t = from[i]; from[i] = from[j]; from[j] = t
                t = to[i];   to[i]   = to[j];   to[j]   = t
            }

    in_block_comment = 0
    count = 0
}

FNR == 1 { in_block_comment = 0 }

{
    line = $0
    i = 1
    m = length(line)

    while (i <= m) {
        c  = substr(line, i, 1)
        c2 = substr(line, i, 2)

        # внутри многострочного комментария
        if (in_block_comment) {
            if (c2 == "*/") { in_block_comment = 0; i += 2; continue }
            i++; continue
        }

        # начало многострочного комментария
        if (c2 == "/*") { in_block_comment = 1; i += 2; continue }

        # однострочный комментарий — остаток строки пропускаем
        if (c2 == "//") break

        # строковый литерал: "…", '…', `…`
        if (c == "\"" || c == "'" || c == "`") {
            quote = c
            i++
            content = ""
            while (i <= m) {
                ch = substr(line, i, 1)
                if (ch == "\\") {              # экранирование
                    content = content substr(line, i, 2)
                    i += 2
                    continue
                }
                if (ch == quote) { i++; break } # конец строки
                content = content ch
                i++
            }

            if (content ~ /[А-Яа-яЁё]/) {
                # применяем все замены из translations.txt
                translated = content
                for (k = 1; k <= n; k++) {
                    while ((pos = index(translated, from[k])) > 0) {
                        translated = substr(translated, 1, pos - 1) \
                                     to[k] \
                                     substr(translated, pos + length(from[k]))
                    }
                }
                # осталась кириллица — фраза переведена не полностью
                if (translated ~ /[А-Яа-яЁё]/ && !(content in seen)) {
                    seen[content] = 1
                    count++
                    if (count > 1) printf "\n"
                    printf "%s\n", content
                }
            }
            continue
        }
        i++
    }
}