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

#[cfg(test)]
mod tests {
    use super::{json_to_lino_value, lino_value_to_json};
    use lino_objects_codec::LinoValue;
    use serde_json::{json, Value};

    #[test]
    fn converts_json_scalars_to_lino_values() {
        assert_eq!(json_to_lino_value(&Value::Null), LinoValue::Null);
        assert_eq!(json_to_lino_value(&json!(true)), LinoValue::Bool(true));
        assert_eq!(json_to_lino_value(&json!(-42)), LinoValue::Int(-42));
        assert_eq!(
            json_to_lino_value(&json!("ready")),
            LinoValue::String("ready".to_string())
        );
    }

    #[test]
    fn converts_json_float_to_lino_float() {
        assert_eq!(json_to_lino_value(&json!(1.25)), LinoValue::Float(1.25));
    }

    #[test]
    fn converts_json_arrays_and_objects_to_lino_values() {
        let value = json!({
            "command": "cargo test",
            "exit_code": 0,
            "output": ["ok", true]
        });

        assert_eq!(
            json_to_lino_value(&value),
            LinoValue::Object(vec![
                (
                    "command".to_string(),
                    LinoValue::String("cargo test".to_string())
                ),
                ("exit_code".to_string(), LinoValue::Int(0)),
                (
                    "output".to_string(),
                    LinoValue::Array(vec![
                        LinoValue::String("ok".to_string()),
                        LinoValue::Bool(true)
                    ]),
                ),
            ])
        );
    }

    #[test]
    fn converts_lino_values_to_json() {
        let value = LinoValue::Array(vec![
            LinoValue::Null,
            LinoValue::Bool(false),
            LinoValue::Int(7),
            LinoValue::Float(2.5),
            LinoValue::String("done".to_string()),
        ]);

        assert_eq!(
            lino_value_to_json(&value),
            json!([null, false, 7, 2.5, "done"])
        );
    }

    #[test]
    fn converts_non_finite_lino_float_to_json_null() {
        assert_eq!(lino_value_to_json(&LinoValue::Float(f64::NAN)), Value::Null);
        assert_eq!(
            lino_value_to_json(&LinoValue::Float(f64::INFINITY)),
            Value::Null
        );
    }
}
