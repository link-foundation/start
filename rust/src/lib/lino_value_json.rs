use lino_objects_codec::LinoValue;
use serde_json::{Map, Number, Value};

pub(crate) fn json_to_lino_value(value: &Value) -> LinoValue {
    match value {
        Value::Null => LinoValue::Null,
        Value::Bool(value) => LinoValue::Bool(*value),
        Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                LinoValue::Int(value)
            } else if let Some(value) = number.as_u64() {
                if value <= i64::MAX as u64 {
                    LinoValue::Int(value as i64)
                } else {
                    LinoValue::Float(value as f64)
                }
            } else {
                LinoValue::Float(number.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(value) => LinoValue::String(value.clone()),
        Value::Array(values) => LinoValue::Array(values.iter().map(json_to_lino_value).collect()),
        Value::Object(values) => LinoValue::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), json_to_lino_value(value)))
                .collect(),
        ),
    }
}

pub(crate) fn lino_value_to_json(value: &LinoValue) -> Value {
    match value {
        LinoValue::Null => Value::Null,
        LinoValue::Bool(value) => Value::Bool(*value),
        LinoValue::Int(value) => Value::Number(Number::from(*value)),
        LinoValue::Float(value) => Number::from_f64(*value)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        LinoValue::String(value) => Value::String(value.clone()),
        LinoValue::Array(values) => Value::Array(values.iter().map(lino_value_to_json).collect()),
        LinoValue::Object(values) => {
            let map: Map<String, Value> = values
                .iter()
                .map(|(key, value)| (key.clone(), lino_value_to_json(value)))
                .collect();
            Value::Object(map)
        }
    }
}
