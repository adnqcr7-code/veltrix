#pragma once
// Minimal JSON reader, enough to read replies from local AI servers.
// Defensive by design: depth-limited, rejects trailing garbage, never throws.
#include <cstddef>
#include <optional>
#include <string>
#include <vector>

namespace vile {

class Json {
public:
    enum class Type { Null, Bool, Number, String, Array, Object };

    static std::optional<Json> parse(const std::string& text);

    Type type() const { return type_; }
    bool is_object() const { return type_ == Type::Object; }
    bool is_array() const { return type_ == Type::Array; }
    bool is_string() const { return type_ == Type::String; }
    bool is_number() const { return type_ == Type::Number; }

    const Json* get(const std::string& key) const;  // object member, or nullptr
    const Json* at(std::size_t i) const;            // array element, or nullptr
    std::size_t size() const { return items_.size(); }
    const std::string& str() const { return str_; }  // empty unless a string
    double num() const { return num_; }
    bool boolean() const { return bool_; }

private:
    friend struct JsonParser;
    Type type_ = Type::Null;
    bool bool_ = false;
    double num_ = 0;
    std::string str_;
    std::vector<std::string> keys_;  // objects only; parallel to items_
    std::vector<Json> items_;        // array elements, or object values
};

// Escapes a string for use inside a JSON string literal (without the quotes).
std::string json_escape(const std::string& s);

}  // namespace vile
