//! lino-objects-codec
//!
//! A Rust library for encoding/decoding objects to/from Links Notation format.
//!
//! This library provides universal serialization/deserialization for Rust objects
//! with support for common types including strings, numbers, booleans, arrays, and objects.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::Value;
use std::collections::HashMap;

/// Type identifiers for Links Notation
mod types {
    pub const NULL: &str = "null";
    pub const BOOL: &str = "bool";
    pub const INT: &str = "int";
    pub const FLOAT: &str = "float";
    pub const STR: &str = "str";
    pub const ARRAY: &str = "array";
    pub const OBJECT: &str = "object";
}

/// A Link represents a node in Links Notation format
#[derive(Debug, Clone, PartialEq)]
pub struct Link {
    /// Optional identifier for the link
    pub id: Option<String>,
    /// Child values (nested links)
    pub values: Vec<Link>,
}

impl Link {
    /// Create a new Link with an ID and no values
    pub fn new(id: impl Into<String>) -> Self {
        Link {
            id: Some(id.into()),
            values: Vec::new(),
        }
    }

    /// Create a new Link with ID and values
    pub fn with_values(id: impl Into<Option<String>>, values: Vec<Link>) -> Self {
        Link {
            id: id.into(),
            values,
        }
    }

    /// Create an empty Link (no ID, no values)
    pub fn empty() -> Self {
        Link {
            id: None,
            values: Vec::new(),
        }
    }

    /// Escape a reference string for Links Notation
    pub fn escape_reference(reference: &str) -> String {
        if reference.is_empty() {
            return String::new();
        }

        let has_single_quote = reference.contains('\'');
        let has_double_quote = reference.contains('"');
        let needs_quoting = reference.contains(':')
            || reference.contains('(')
            || reference.contains(')')
            || reference.contains(' ')
            || reference.contains('\t')
            || reference.contains('\n')
            || reference.contains('\r')
            || has_single_quote
            || has_double_quote;

        if has_single_quote && has_double_quote {
            // Escape single quotes and wrap in single quotes
            format!("'{}'", reference.replace('\'', "\\'"))
        } else if has_double_quote {
            format!("'{}'", reference)
        } else if has_single_quote {
            format!("\"{}\"", reference)
        } else if needs_quoting {
            format!("'{}'", reference)
        } else {
            reference.to_string()
        }
    }

    /// Format the link as a string
    pub fn format(&self) -> String {
        // Empty link
        if self.id.is_none() && self.values.is_empty() {
            return "()".to_string();
        }

        // Link with only ID, no values
        if self.values.is_empty() {
            if let Some(ref id) = self.id {
                let escaped = Self::escape_reference(id);
                return format!("({})", escaped);
            }
            return "()".to_string();
        }

        // Format values recursively
        let values_str: String = self
            .values
            .iter()
            .map(|v| {
                if v.values.is_empty() {
                    if let Some(ref id) = v.id {
                        Self::escape_reference(id)
                    } else {
                        String::new()
                    }
                } else {
                    v.format()
                }
            })
            .collect::<Vec<_>>()
            .join(" ");

        // Link with values only (no id)
        if self.id.is_none() {
            return format!("({})", values_str);
        }

        // Link with ID and values
        let id_str = Self::escape_reference(self.id.as_ref().unwrap());
        format!("({}: {})", id_str, values_str)
    }
}

/// Object Codec for encoding/decoding objects to/from Links Notation
pub struct ObjectCodec {
    encode_memo: HashMap<usize, String>,
    encode_counter: usize,
    needs_id: std::collections::HashSet<usize>,
    decode_memo: HashMap<String, Value>,
}

impl ObjectCodec {
    /// Create a new ObjectCodec
    pub fn new() -> Self {
        ObjectCodec {
            encode_memo: HashMap::new(),
            encode_counter: 0,
            needs_id: std::collections::HashSet::new(),
            decode_memo: HashMap::new(),
        }
    }

    /// Reset the codec state
    fn reset(&mut self) {
        self.encode_memo.clear();
        self.encode_counter = 0;
        self.needs_id.clear();
        self.decode_memo.clear();
    }

    /// Encode a serde_json Value to Links Notation format
    pub fn encode(&mut self, value: &Value) -> String {
        self.reset();
        let link = self.encode_value(value);
        link.format()
    }

    /// Encode a value to a Link
    fn encode_value(&mut self, value: &Value) -> Link {
        match value {
            Value::Null => Link::with_values(None, vec![Link::new(types::NULL)]),
            Value::Bool(b) => {
                Link::with_values(None, vec![Link::new(types::BOOL), Link::new(b.to_string())])
            }
            Value::Number(n) => {
                if n.is_i64() || n.is_u64() {
                    Link::with_values(None, vec![Link::new(types::INT), Link::new(n.to_string())])
                } else {
                    Link::with_values(
                        None,
                        vec![Link::new(types::FLOAT), Link::new(n.to_string())],
                    )
                }
            }
            Value::String(s) => {
                let b64 = BASE64.encode(s.as_bytes());
                Link::with_values(None, vec![Link::new(types::STR), Link::new(b64)])
            }
            Value::Array(arr) => {
                let mut parts = vec![Link::new(types::ARRAY)];
                for item in arr {
                    parts.push(self.encode_value(item));
                }
                Link::with_values(None, parts)
            }
            Value::Object(obj) => {
                let mut parts = vec![Link::new(types::OBJECT)];
                for (key, val) in obj {
                    let key_link = self.encode_value(&Value::String(key.clone()));
                    let val_link = self.encode_value(val);
                    let pair = Link::with_values(None, vec![key_link, val_link]);
                    parts.push(pair);
                }
                Link::with_values(None, parts)
            }
        }
    }

    /// Decode Links Notation to a serde_json Value
    pub fn decode(&mut self, notation: &str) -> Result<Value, String> {
        self.reset();
        let link = self.parse(notation)?;
        self.decode_link(&link)
    }

    /// Simple recursive descent parser for Links Notation
    fn parse(&self, notation: &str) -> Result<Link, String> {
        let notation = notation.trim();
        if notation.is_empty() {
            return Ok(Link::empty());
        }

        let mut parser = Parser::new(notation);
        parser.parse_link()
    }

    /// Decode a Link to a serde_json Value
    fn decode_link(&mut self, link: &Link) -> Result<Value, String> {
        if link.values.is_empty() {
            if let Some(ref id) = link.id {
                // Check memo for references
                if let Some(val) = self.decode_memo.get(id) {
                    return Ok(val.clone());
                }
                // Just an ID - return as string
                return Ok(Value::String(id.clone()));
            }
            return Ok(Value::Null);
        }

        // Get type marker
        let first = link.values.first().ok_or("Empty link values")?;
        let type_marker = first.id.as_deref().unwrap_or("");

        match type_marker {
            types::NULL => Ok(Value::Null),
            types::BOOL => {
                let val = link.values.get(1).and_then(|v| v.id.as_deref());
                Ok(Value::Bool(val == Some("true")))
            }
            types::INT => {
                let val = link.values.get(1).and_then(|v| v.id.as_deref());
                match val {
                    Some(s) => s
                        .parse::<i64>()
                        .map(|n| Value::Number(n.into()))
                        .map_err(|e| e.to_string()),
                    None => Ok(Value::Number(0.into())),
                }
            }
            types::FLOAT => {
                let val = link.values.get(1).and_then(|v| v.id.as_deref());
                match val {
                    Some("NaN") => Ok(Value::Null), // JSON doesn't support NaN
                    Some("Infinity") | Some("-Infinity") => Ok(Value::Null), // JSON doesn't support Infinity
                    Some(s) => s
                        .parse::<f64>()
                        .map(|n| {
                            serde_json::Number::from_f64(n)
                                .map(Value::Number)
                                .unwrap_or(Value::Null)
                        })
                        .map_err(|e| e.to_string()),
                    None => Ok(Value::Number(serde_json::Number::from_f64(0.0).unwrap())),
                }
            }
            types::STR => {
                let val = link.values.get(1).and_then(|v| v.id.as_deref());
                match val {
                    Some(b64) => {
                        let bytes = BASE64.decode(b64).map_err(|e| e.to_string())?;
                        let s = String::from_utf8(bytes).map_err(|e| e.to_string())?;
                        Ok(Value::String(s))
                    }
                    None => Ok(Value::String(String::new())),
                }
            }
            types::ARRAY => {
                let mut arr = Vec::new();
                for item in link.values.iter().skip(1) {
                    arr.push(self.decode_link(item)?);
                }
                Ok(Value::Array(arr))
            }
            types::OBJECT => {
                let mut obj = serde_json::Map::new();
                for pair in link.values.iter().skip(1) {
                    if pair.values.len() >= 2 {
                        let key = self.decode_link(&pair.values[0])?;
                        let val = self.decode_link(&pair.values[1])?;
                        if let Value::String(k) = key {
                            obj.insert(k, val);
                        }
                    }
                }
                Ok(Value::Object(obj))
            }
            _ => Err(format!("Unknown type marker: {}", type_marker)),
        }
    }
}

impl Default for ObjectCodec {
    fn default() -> Self {
        Self::new()
    }
}

/// Simple parser for Links Notation
struct Parser<'a> {
    input: &'a str,
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(input: &'a str) -> Self {
        Parser { input, pos: 0 }
    }

    fn peek(&self) -> Option<char> {
        self.input[self.pos..].chars().next()
    }

    fn advance(&mut self) {
        if let Some(c) = self.peek() {
            self.pos += c.len_utf8();
        }
    }

    fn skip_whitespace(&mut self) {
        while let Some(c) = self.peek() {
            if c.is_whitespace() {
                self.advance();
            } else {
                break;
            }
        }
    }

    fn parse_link(&mut self) -> Result<Link, String> {
        self.skip_whitespace();

        if self.peek() != Some('(') {
            // Parse as simple ID
            let id = self.parse_id()?;
            return Ok(Link::new(id));
        }

        self.advance(); // consume '('
        self.skip_whitespace();

        // Check for empty link
        if self.peek() == Some(')') {
            self.advance();
            return Ok(Link::empty());
        }

        // Parse first element (could be ID followed by colon, or just a value)
        let mut values = Vec::new();
        let mut id = None;

        // First, try to parse an ID and check for colon
        let first = self.parse_id_or_link()?;

        self.skip_whitespace();

        if self.peek() == Some(':') {
            // This was an ID
            self.advance(); // consume ':'
            id = first.id;

            // Parse remaining values
            loop {
                self.skip_whitespace();
                if self.peek() == Some(')') {
                    self.advance();
                    break;
                }
                if self.peek().is_none() {
                    return Err("Unexpected end of input".to_string());
                }
                values.push(self.parse_id_or_link()?);
            }
        } else {
            // No colon - first element is a value
            values.push(first);

            // Parse remaining values
            loop {
                self.skip_whitespace();
                if self.peek() == Some(')') {
                    self.advance();
                    break;
                }
                if self.peek().is_none() {
                    return Err("Unexpected end of input".to_string());
                }
                values.push(self.parse_id_or_link()?);
            }
        }

        Ok(Link::with_values(id, values))
    }

    fn parse_id_or_link(&mut self) -> Result<Link, String> {
        self.skip_whitespace();

        if self.peek() == Some('(') {
            self.parse_link()
        } else {
            let id = self.parse_id()?;
            Ok(Link::new(id))
        }
    }

    fn parse_id(&mut self) -> Result<String, String> {
        self.skip_whitespace();

        // Check for quoted string
        if self.peek() == Some('"') || self.peek() == Some('\'') {
            return self.parse_quoted_string();
        }

        // Parse unquoted identifier
        let mut id = String::new();
        while let Some(c) = self.peek() {
            if c.is_whitespace() || c == ':' || c == '(' || c == ')' {
                break;
            }
            id.push(c);
            self.advance();
        }

        if id.is_empty() {
            return Err("Expected identifier".to_string());
        }

        Ok(id)
    }

    fn parse_quoted_string(&mut self) -> Result<String, String> {
        let quote = self.peek().ok_or("Expected quote")?;
        self.advance(); // consume opening quote

        let mut result = String::new();
        let mut escaped = false;

        loop {
            match self.peek() {
                None => return Err("Unterminated string".to_string()),
                Some(c) => {
                    self.advance();
                    if escaped {
                        result.push(c);
                        escaped = false;
                    } else if c == '\\' {
                        escaped = true;
                    } else if c == quote {
                        break;
                    } else {
                        result.push(c);
                    }
                }
            }
        }

        Ok(result)
    }
}

/// Convenience function to encode a serde_json Value to Links Notation
pub fn encode(value: &Value) -> String {
    let mut codec = ObjectCodec::new();
    codec.encode(value)
}

/// Convenience function to decode Links Notation to a serde_json Value
pub fn decode(notation: &str) -> Result<Value, String> {
    let mut codec = ObjectCodec::new();
    codec.decode(notation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_encode_null() {
        let encoded = encode(&Value::Null);
        assert_eq!(encoded, "(null)");
    }

    #[test]
    fn test_encode_bool() {
        let encoded = encode(&json!(true));
        assert_eq!(encoded, "(bool true)");

        let encoded = encode(&json!(false));
        assert_eq!(encoded, "(bool false)");
    }

    #[test]
    fn test_encode_int() {
        let encoded = encode(&json!(42));
        assert_eq!(encoded, "(int 42)");

        let encoded = encode(&json!(-123));
        assert_eq!(encoded, "(int -123)");
    }

    #[test]
    fn test_encode_float() {
        let encoded = encode(&json!(3.14));
        assert_eq!(encoded, "(float 3.14)");
    }

    #[test]
    fn test_encode_string() {
        let encoded = encode(&json!("hello"));
        // "hello" in base64 is "aGVsbG8="
        assert_eq!(encoded, "(str aGVsbG8=)");
    }

    #[test]
    fn test_encode_array() {
        let encoded = encode(&json!([1, 2, 3]));
        assert_eq!(encoded, "(array (int 1) (int 2) (int 3))");
    }

    #[test]
    fn test_encode_object() {
        let obj = json!({"name": "Alice", "age": 30});
        let encoded = encode(&obj);
        // Object order might vary, so just check it contains expected parts
        assert!(encoded.contains("object"));
        assert!(encoded.contains("str"));
        assert!(encoded.contains("int 30"));
    }

    #[test]
    fn test_decode_null() {
        let decoded = decode("(null)").unwrap();
        assert_eq!(decoded, Value::Null);
    }

    #[test]
    fn test_decode_bool() {
        let decoded = decode("(bool true)").unwrap();
        assert_eq!(decoded, json!(true));

        let decoded = decode("(bool false)").unwrap();
        assert_eq!(decoded, json!(false));
    }

    #[test]
    fn test_decode_int() {
        let decoded = decode("(int 42)").unwrap();
        assert_eq!(decoded, json!(42));
    }

    #[test]
    fn test_decode_string() {
        let decoded = decode("(str aGVsbG8=)").unwrap();
        assert_eq!(decoded, json!("hello"));
    }

    #[test]
    fn test_roundtrip_simple() {
        let original = json!({"name": "Alice", "active": true, "count": 42});
        let encoded = encode(&original);
        let decoded = decode(&encoded).unwrap();

        // Compare via JSON serialization to handle key ordering
        assert_eq!(
            serde_json::to_string(&original).unwrap(),
            serde_json::to_string(&decoded).unwrap()
        );
    }

    #[test]
    fn test_roundtrip_nested() {
        let original = json!({
            "user": {
                "name": "Bob",
                "tags": ["admin", "user"]
            }
        });
        let encoded = encode(&original);
        let decoded = decode(&encoded).unwrap();

        assert_eq!(
            serde_json::to_string(&original).unwrap(),
            serde_json::to_string(&decoded).unwrap()
        );
    }

    #[test]
    fn test_unicode_string() {
        let original = json!("Hello 世界 🌍");
        let encoded = encode(&original);
        let decoded = decode(&encoded).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn test_link_escape_reference() {
        assert_eq!(Link::escape_reference("simple"), "simple");
        assert_eq!(Link::escape_reference("with space"), "'with space'");
        assert_eq!(Link::escape_reference("with:colon"), "'with:colon'");
        assert_eq!(Link::escape_reference("with(paren)"), "'with(paren)'");
    }
}
