# SnakeYAML собирает объекты рефлексией — без этого release-сборка молча отдаёт
# пустой конфиг движку.
-keep class org.yaml.snakeyaml.** { *; }
-dontwarn org.yaml.snakeyaml.**

# kotlinx.serialization: сериализаторы генерируются как вложенные классы.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class ru.appswire.novpn.** {
    *** Companion;
}
-keepclasseswithmembers class ru.appswire.novpn.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Имена методов, которые ищет JNI-хелпер.
-keepclasseswithmembernames class ru.appswire.novpn.vpn.Native {
    native <methods>;
}

-dontwarn org.slf4j.**
