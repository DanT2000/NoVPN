import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Ключ подписи лежит ВНЕ репозитория, рядом с ключом обновлений десктопа
// (d:/Project/.novpn-keys). В git его быть не должно: потеря ключа означает, что
// обновить уже установленное приложение будет нечем — Android не поставит поверх
// apk, подписанный другим ключом.
val signingProps = Properties().apply {
    val f = rootProject.file("../../../.novpn-keys/novpn-android.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "ru.appswire.novpn"
    compileSdk = 35
    ndkVersion = "27.1.12297006"

    defaultConfig {
        applicationId = "ru.appswire.novpn"
        // Android 8.0: ниже уже почти никого, а VpnService там полностью рабочий.
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        ndk {
            // Движок скачивается под эти же ABI (scripts/fetch-engine.py).
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    // Движок весит ~50 МБ на архитектуру. Универсальный APK с тремя копиями — это
    // 79 МБ, из которых телефону нужна ровно одна. Разбиваем по ABI; универсальный
    // тоже собираем — он удобен, когда заранее неизвестно, на чём будут ставить.
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = true
        }
    }

    signingConfigs {
        create("release") {
            val store = signingProps.getProperty("storeFile")
            if (store != null) {
                storeFile = file(store)
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // Без ключа собираем неподписанную сборку, а не падаем: так проект
            // остаётся собираемым на чужой машине.
            signingConfig = if (signingProps.getProperty("storeFile") != null) {
                signingConfigs.getByName("release")
            } else {
                null
            }
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        jniLibs {
            // КРИТИЧНО: движок mihomo лежит в jniLibs как libmihomo.so и запускается
            // как процесс. Запустить можно только реальный файл на диске, а он там
            // появляется лишь при «старой» упаковке (extractNativeLibs=true).
            // С useLegacyPackaging=false библиотеки остаются внутри apk, и exec падает.
            useLegacyPackaging = true
        }
        resources {
            excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
        }
    }
    lint {
        // Сборка не должна падать из-за советов линтера, но отчёт нужен.
        abortOnError = false
        warningsAsErrors = false
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.snakeyaml)

    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
}
