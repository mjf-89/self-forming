plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val selfFormingKeystore = providers.environmentVariable("SELF_FORMING_KEYSTORE_PATH").orNull
val selfFormingPassword = providers.environmentVariable("SELF_FORMING_KEYSTORE_PASSWORD").orNull
val signingRequired = providers.environmentVariable("SELF_FORMING_SIGNING_REQUIRED").orNull == "true"
val signInScheme = "selfforming"
check(!signingRequired || (!selfFormingKeystore.isNullOrBlank() && !selfFormingPassword.isNullOrBlank())) {
    "Distributed APKs require the persistent Self Forming signing key. Configure the repository signing secrets."
}
check((selfFormingKeystore == null) == (selfFormingPassword == null)) { "Incomplete Self Forming signing configuration" }

val browserAssets = rootProject.layout.projectDirectory.dir("../../dist/app")
val generatedAssets = layout.buildDirectory.dir("generated/selfFormingAssets")
val syncBrowserAssets by tasks.registering(Sync::class) {
    from(browserAssets)
    into(generatedAssets.map { it.dir("web") })
    doFirst {
        check(browserAssets.file("index.html").asFile.isFile) {
            "Browser assets missing. Run the web build (scripts/build.mjs) at the repository root first."
        }
    }
}

android {
    namespace = "md.incept.selfforming"
    compileSdk = 36
    defaultConfig {
        applicationId = "md.incept.selfforming"
        minSdk = 28
        targetSdk = 36
        versionCode = providers.gradleProperty("selfFormingVersionCode").map { it.toInt() }.getOrElse(1)
        versionName = "0.4.2"
        manifestPlaceholders["signInScheme"] = signInScheme
        buildConfigField("String", "SIGN_IN_SCHEME", "\"$signInScheme\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += listOf("arm64-v8a") }
    }
    buildFeatures { buildConfig = true }
    signingConfigs {
        if (selfFormingKeystore != null) create("selfForming") {
            storeFile = file(selfFormingKeystore)
            storeType = "PKCS12"
            storePassword = selfFormingPassword
            keyAlias = "self-forming"
            keyPassword = selfFormingPassword
        }
    }
    buildTypes {
        debug {
            if (selfFormingKeystore != null) signingConfig = signingConfigs.getByName("selfForming")
        }
        release {
            isMinifyEnabled = false
            if (selfFormingKeystore != null) signingConfig = signingConfigs.getByName("selfForming")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets.getByName("main").assets.srcDir(generatedAssets)
    // scripts/pack-source.sh: the repository itself, so the installed app can rebuild and update itself.
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/selfSource"))
    sourceSets.getByName("main").assets.srcDir(rootProject.layout.projectDirectory.dir("../../dist/runtime/assets"))
    sourceSets.getByName("main").jniLibs.srcDir(rootProject.layout.projectDirectory.dir("../../dist/runtime/jniLibs"))
    packaging { jniLibs { useLegacyPackaging = true; keepDebugSymbols += setOf("**/*.so") } }
    testOptions { unitTests.isReturnDefaultValues = true }
}
kotlin { compilerOptions { jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17 } }
tasks.named("preBuild").configure {
    dependsOn(syncBrowserAssets)
    doFirst {
        if (signingRequired) check(layout.buildDirectory.file("generated/selfSource/self-source/source.zip").get().asFile.isFile) {
            "Distributed APKs require their self-rebuild source. Run scripts/pack-source.sh before Gradle."
        }
        for (abi in listOf("arm64-v8a")) {
            val runtime = rootProject.file("../../dist/runtime")
            check(runtime.resolve("assets/runtime/ubuntu-$abi.zip").isFile &&
                runtime.resolve("assets/runtime/ubuntu-$abi.json").isFile &&
                runtime.resolve("jniLibs/$abi/libproot.so").isFile &&
                runtime.resolve("jniLibs/$abi/libproot-loader.so").isFile) {
                "Ubuntu/PRoot payload missing for $abi. Run scripts/fetch-runtime.sh first."
            }
        }
    }
}

dependencies {
    implementation("androidx.core:core:1.16.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.sqlite:sqlite-bundled:2.6.2")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    androidTestImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
}
