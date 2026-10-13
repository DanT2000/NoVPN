cmake_minimum_required(VERSION 3.22.1)
project("novpnspawn" C)

add_library(novpnspawn SHARED spawn.c)

# Сегменты выравниваем на 16 КБ. NDK r27 по умолчанию собирает с шагом 4 КБ, а
# Google Play с ноября 2025 не принимает сборки с targetSdk 35+, где 64-битные .so так
# выровнены; на телефоне с ядром на 16 КБ страниц такая библиотека ещё и не грузится
# (Native.ensureLoaded → false, VPN не стартует). 16 КБ подходят и ядрам на 4 КБ.
target_link_options(novpnspawn PRIVATE "-Wl,-z,max-page-size=16384")

# log нужен только для отладочной печати; оставлен, чтобы не ловить linker error
# при добавлении __android_log_print во время разбора проблем.
find_library(log-lib log)
target_link_libraries(novpnspawn ${log-lib})
