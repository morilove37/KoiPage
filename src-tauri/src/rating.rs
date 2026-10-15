/// Ratings are non-negative 0-10 values. Compensate for binary representations
/// such as 8.725 * 100 = 872.4999999999999 before rounding to hundredths.
pub fn round_rating(score: f64) -> f64 {
    (score * 100.0 + 1e-10).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_half_way_scores_and_boundaries() {
        for (input, expected) in [(8.725, 8.73), (7.865, 7.87), (8.724, 8.72),
            (1.005, 1.01), (0.0, 0.0), (0.005, 0.01), (9.999, 10.0), (10.0, 10.0)] {
            assert_eq!(round_rating(input), expected);
        }
    }
}
