cmake_minimum_required(VERSION 3.22.1)
project("novpnspawn" C)

add_library(novpnspawn SHARED spawn.c)

# log нужен только для отладочной печати; оставлен, чтобы не ловить linker error
# при добавлении __android_log_print во время разбора проблем.
find_library(log-lib log)
target_link_libraries(novpnspawn ${log-lib})
