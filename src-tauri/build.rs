fn main() {
    for name in [
        "SAVVY_SERVICE_URL",
        "SAVVY_OIDC_ISSUER",
        "SAVVY_OIDC_CLIENT_ID",
        "SAVVY_OIDC_AUDIENCE",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
        if std::env::var_os("CARGO_FEATURE_LOCAL_INTEGRATION").is_some() {
            let value = std::env::var(name)
                .expect("local integration builds require all four SAVVY endpoint/client settings");
            assert!(
                !value.trim().is_empty() && !value.contains(['\r', '\n']),
                "invalid local integration setting"
            );
            println!("cargo:rustc-env={name}={value}");
        }
    }
    tauri_build::build()
}
