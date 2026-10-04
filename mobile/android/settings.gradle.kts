pluginManagement {
    val flutterSdkPath =
        run {
            val properties = java.util.Properties()
            file("local.properties").inputStream().use { properties.load(it) }
            val flutterSdkPath = properties.getProperty("flutter.sdk")
            require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
            flutterSdkPath
        }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        // Multiple mirrors for better availability
        maven("https://maven.myket.ir")                    // MyKet (Iranian)
        maven("https://repo.huaweicloud.com/repository/maven/")  // Huawei Cloud (Chinese) - includes Google artifacts
        maven("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/")  // Tencent (Chinese)
        // google() - unreachable due to network restrictions
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        // Multiple mirrors for better availability
        maven("https://maven.myket.ir")
        maven("https://repo.huaweicloud.com/repository/maven/")
        maven("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/")
        // google() - unreachable due to network restrictions
        mavenCentral()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "8.13.1" apply false
    id("org.jetbrains.kotlin.android") version "2.2.20" apply false
}

include(":app")
