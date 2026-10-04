use serde::Serialize;
use std::collections::VecDeque;

#[derive(Clone, Debug, Serialize)]
pub(crate) struct OutputLine {
    pub stream: &'static str,
    pub message: String,
}

#[derive(Default)]
pub(crate) struct OutputTail {
    lines: VecDeque<OutputLine>,
    characters: usize,
}

impl OutputTail {
    pub fn push(&mut self, stream: &'static str, message: &str) {
        let message: String = message.chars().take(2000).collect();
        self.characters += message.chars().count();
        self.lines.push_back(OutputLine { stream, message });
        while self.lines.len() > 80 || self.characters > 20_000 {
            if let Some(line) = self.lines.pop_front() {
                self.characters -= line.message.chars().count();
            }
        }
    }
    pub fn snapshot(&self) -> Vec<OutputLine> {
        self.lines.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retains_last_lines_from_both_streams_with_bounded_unicode_output() {
        let mut tail = OutputTail::default();
        for n in 0..100 {
            tail.push("stdout", &n.to_string());
        }
        let lines = tail.snapshot();
        assert_eq!(lines.len(), 80);
        assert_eq!(lines[0].message, "20");
        tail.push("stderr", "Ошибка запуска");
        assert_eq!(tail.snapshot().last().unwrap().stream, "stderr");
        for _ in 0..20 {
            tail.push("stderr", &"я".repeat(4000));
        }
        assert_eq!(tail.snapshot().len(), 10);
        assert!(
            tail.snapshot()
                .iter()
                .all(|line| line.message.chars().count() == 2000)
        );
        assert!(OutputTail::default().snapshot().is_empty());
    }
}
