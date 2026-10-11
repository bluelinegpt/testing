plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Firebase's Google Services Gradle plugin is applied CONDITIONALLY — only
// when a real `google-services.json` has been dropped into this directory.
// This is what lets the dev APK build successfully today with no Firebase
// project configured, and start working automatically (no further code
// changes) the moment a real file is added — see Prompt 15 (Push
// Notifications) §R.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

android {

    
    
    namespace = "com.bluelinegpt.mobile"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion
    buildFeatures {
        resValues = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.bluelinegpt.mobile"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    flavorDimensions += "environment"
    productFlavors {
        create("dev") {
            dimension = "environment"
            applicationIdSuffix = ".dev"
            resValue("string", "app_name", "TawseelHub Dev")
        }
        create("staging") {
            dimension = "environment"
            applicationIdSuffix = ".staging"
            resValue("string", "app_name", "TawseelHub Staging")
        }
        create("prod") {
            dimension = "environment"
            resValue("string", "app_name", "TawseelHub")
        }
    }

    // Release signing is intentionally not sourced from this repository.
    // CI or the release operator must inject an approved private signing
    // configuration. Until it does, release builds fall back to the local
    // auto-generated DEBUG keystore — not a secret, different on every
    // machine — because Android refuses to install an UNSIGNED apk at all
    // ("package appears to be invalid"), which made sideloading staging
    // builds onto test phones impossible. A CI-injected config must replace
    // this assignment for any store or customer distribution.
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

// The production Android app is also saved as TawseelHub.apk, next to
// Flutter's own app-prod-release.apk in build/app/outputs/flutter-apk.
// Flutter's file keeps its name because the Flutter tool looks for it after
// Gradle finishes; renaming it instead would make `flutter build apk` fail.
afterEvaluate {
    tasks.matching { it.name == "assembleProdRelease" }.configureEach {
        val outputs = layout.buildDirectory.dir("outputs")
        doLast {
            val source = outputs.get().file("apk/prod/release/app-prod-release.apk").asFile
            if (source.exists()) {
                val targetDir = outputs.get().dir("flutter-apk").asFile
                targetDir.mkdirs()
                source.copyTo(java.io.File(targetDir, "TawseelHub.apk"), overwrite = true)
                println("Saved ${'$'}{targetDir}${'$'}{java.io.File.separator}TawseelHub.apk")
            }
        }
    }
}
