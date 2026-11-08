plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val vCode = (project.findProperty("versionCode") as String?)?.toIntOrNull() ?: 1
val ksPath = project.findProperty("ks") as String?

android {
    namespace = "hu.isucode.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "hu.isucode.app"
        minSdk = 28
        targetSdk = 35
        versionCode = vCode
        versionName = "1.0.$vCode"
    }

    signingConfigs {
        create("release") {
            if (ksPath != null) {
                storeFile = file(ksPath)
                storePassword = System.getenv("KS_PASS")
                keyAlias = "isucode"
                keyPassword = System.getenv("KS_PASS")
                storeType = "PKCS12"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
}
