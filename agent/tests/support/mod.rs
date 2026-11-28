//! Shared by the integration tests that start one of the agent's example programs (`examples/`).

use std::path::PathBuf;

/// The example program `name` that `cargo test` builds along with the tests.
///
/// Cargo puts the examples in `<target>/<profile>/examples`. Where the test executable itself is depends on the
/// Cargo version: `<target>/<profile>/deps/<test>` until Cargo 1.99, and
/// `<target>/<profile>/build/<package>/<hash>/out/<test>` with the build-directory layout of Cargo 1.100. The
/// nearest `examples/<name>` above the test executable is therefore the one, whichever layout built it.
pub fn example(name: &str) -> PathBuf {
    let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    let test = std::env::current_exe().expect("the test executable's path");
    test.ancestors()
        .skip(1)
        .map(|directory| directory.join("examples").join(&file))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| {
            panic!(
                "build the example first: no examples/{file} above {}",
                test.display()
            )
        })
}
