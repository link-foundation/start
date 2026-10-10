// Generated from scripts/parity-threshold.mjs by meta-language eb0574d5528babd3b4aadece81590d8e2230b99b.
// Do not edit: run node scripts/generate-rust.mjs.
// meta-language:self-translation:v1 source=JavaScript target=Rust sha256=d79a96822fedd9b7b4c1b6ada97378bf8bf02ddb3826fa2eec8e85ee2af3e33b bytes=147

// meta-language:prelude begin
#![allow(unused, unreachable_patterns, non_snake_case, non_camel_case_types, invalid_nan_comparisons)]
// meta-language:prelude end

// meta-language:translated JavaScript export_statement items=1 sha256=773dc437396eacfe26dd1e82a75c791c6bc6df97ba32d83ce32a3cafd9a1f446
// | /** @param {number} javascriptTests @returns {number} */
// | export function minimumRustTestCount(javascriptTests) {
// |   return javascriptTests * 0.9;
// | }
pub fn minimum_rust_test_count(javascript_tests: f64) -> f64 {
    (javascript_tests * 0.9f64)
}
