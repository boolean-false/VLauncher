import org.jetbrains.compose.desktop.application.dsl.TargetFormat

plugins {
    kotlin("jvm") version "1.9.23"
    id("org.jetbrains.compose") version "1.6.20-dev1646"
    kotlin("plugin.serialization")
}

version = "1.0.1"

repositories {
    google()
    mavenCentral()
    maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")
}

dependencies {
    implementation("org.slf4j:slf4j-api:1.7.30")
    implementation("org.slf4j:slf4j-simple:1.7.30")

    implementation(compose.desktop.currentOs)
    implementation(compose.foundation)
    implementation(compose.materialIconsExtended)
    //implementation(compose.material3)

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.6.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-swing:1.6.3")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    implementation("org.jetbrains.kotlinx:kotlinx-collections-immutable:0.3.7")
    // Decompose
    val decompose_version = "3.0.0"
    implementation("com.arkivanov.decompose:decompose:$decompose_version")
    implementation("com.arkivanov.decompose:extensions-compose:$decompose_version")

    //    testImplementation(kotlin("test"))

    // Ktor
    val ktor_version = "2.3.11"
    implementation("io.ktor:ktor-client-core:$ktor_version")
    implementation("io.ktor:ktor-client-cio:$ktor_version")
    implementation("io.ktor:ktor-client-content-negotiation:$ktor_version")
    implementation("io.ktor:ktor-serialization-kotlinx-json:$ktor_version")

    // Pprint
    implementation("io.exoquery:pprint-kotlin:2.0.2")

    // JNA
    implementation("net.java.dev.jna:jna:5.14.0")
    implementation("net.java.dev.jna:jna-platform:5.14.0")

    // Zip
    implementation("net.lingala.zip4j:zip4j:2.11.5")
}

compose.desktop {
    application {
        mainClass = "MainKt"
        nativeDistributions {
            targetFormats(TargetFormat.Dmg, TargetFormat.Msi, TargetFormat.Deb)
        }
        buildTypes.release.proguard {
            configurationFiles.from(project.file("proguard-rules.pro"))
        }
    }
}

kotlin {
    jvmToolchain(17)
}
