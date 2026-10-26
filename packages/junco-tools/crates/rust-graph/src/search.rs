//! BM25 over node name/path/signature with an in-degree boost.

use std::borrow::Cow;

use crate::lang::Language;

use crate::model::{Graph, Node, SearchHit, SearchQuery, SearchResult};

const K1: f64 = 1.2;
const B: f64 = 0.75;

/// Split on non-alphanumerics and camelCase boundaries; lowercase; drop tokens shorter than 2 chars.
pub fn tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for word in text.split(|c: char| !c.is_alphanumeric()) {
        let chars: Vec<char> = word.chars().collect();
        let mut start = 0;
        for i in 1..chars.len() {
            let (prev, cur) = (chars[i - 1], chars[i]);
            let lower_upper = (prev.is_lowercase() || prev.is_ascii_digit()) && cur.is_uppercase();
            let acronym_end = prev.is_uppercase()
                && cur.is_uppercase()
                && chars.get(i + 1).is_some_and(|c| c.is_lowercase());
            if lower_upper || acronym_end {
                out.push(chars[start..i].iter().collect::<String>());
                start = i;
            }
        }
        out.push(chars[start..].iter().collect::<String>());
    }
    out.into_iter()
        .map(|t| t.to_lowercase())
        .filter(|t| t.chars().count() >= 2)
        .collect()
}

pub fn search(graph: &Graph, query: &SearchQuery) -> SearchResult {
    let mut terms = tokens(&query.query);
    terms.sort();
    terms.dedup();
    let limit = if query.limit == 0 {
        10
    } else {
        query.limit.min(100)
    } as usize;
    let wanted_lang = query.lang.as_deref().map(|l| {
        Language::from_alias(l).map_or_else(
            || l.trim().to_ascii_lowercase(),
            |s| s.canonical_name().to_string(),
        )
    });
    let exact = query.query.trim().to_lowercase();
    let degrees = graph.degrees();

    // ponytail: index rebuilt per call; persist it if a call exceeds ~200 ms on large repos.
    struct Doc<'g> {
        node: Cow<'g, Node>,
        tf: Vec<f64>,
        len: f64,
    }
    let docs: Vec<Doc<'_>> = graph
        .all_nodes()
        .map(|(_, node)| {
            let fields = [
                (tokens(&node.name), 3.0),
                (tokens(&node.path), 2.0),
                (tokens(&node.signature), 1.0),
            ];
            let len = fields.iter().map(|(t, w)| t.len() as f64 * w).sum();
            let tf = terms
                .iter()
                .map(|term| {
                    fields
                        .iter()
                        .map(|(t, w)| t.iter().filter(|x| *x == term).count() as f64 * w)
                        .sum()
                })
                .collect();
            Doc { node, tf, len }
        })
        .collect();
    let n = docs.len() as f64;
    let avgdl = (docs.iter().map(|d| d.len).sum::<f64>() / n.max(1.0)).max(1.0);
    let idf: Vec<f64> = (0..terms.len())
        .map(|i| {
            let df = docs.iter().filter(|d| d.tf[i] > 0.0).count() as f64;
            (1.0 + (n - df + 0.5) / (df + 0.5)).ln()
        })
        .collect();

    let mut hits: Vec<(f64, u32, u32, Cow<'_, Node>)> = docs
        .into_iter()
        .filter(|d| {
            let node = &d.node;
            query.kinds.as_ref().is_none_or(|k| k.contains(&node.kind))
                && query
                    .path_prefix
                    .as_ref()
                    .is_none_or(|p| node.path.starts_with(p.as_str()))
                && wanted_lang
                    .as_ref()
                    .is_none_or(|l| graph.files.get(&node.path).is_some_and(|f| &f.lang == l))
        })
        .filter_map(|d| {
            let mut score: f64 = d
                .tf
                .iter()
                .zip(&idf)
                .filter(|(tf, _)| **tf > 0.0)
                .map(|(tf, idf)| idf * tf * (K1 + 1.0) / (tf + K1 * (1.0 - B + B * d.len / avgdl)))
                .sum();
            if score <= 0.0 {
                return None;
            }
            let (in_degree, out_degree) =
                degrees.get(d.node.id.as_str()).copied().unwrap_or_default();
            score *= 1.0 + 0.1 * (1.0 + f64::from(in_degree)).ln();
            if d.node.name.to_lowercase() == exact {
                score *= 1.5;
            }
            Some((score, in_degree, out_degree, d.node))
        })
        .collect();
    let total_candidates = hits.len() as u32;
    hits.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.3.id.cmp(&b.3.id)));
    let hits = hits
        .into_iter()
        .take(limit)
        .map(|(score, in_degree, out_degree, node)| SearchHit {
            node: node.into_owned(),
            score,
            in_degree,
            out_degree,
        })
        .collect();
    SearchResult {
        hits,
        total_candidates,
    }
}

#[cfg(test)]
mod tests {
    use super::tokens;

    #[test]
    fn tokenizer_splits_camel_and_snake() {
        assert_eq!(
            tokens("parseHTTPRequest my_fn x"),
            ["parse", "http", "request", "my", "fn"]
        );
    }
}
