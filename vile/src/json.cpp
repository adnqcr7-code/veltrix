#include "vile/json.hpp"

#include <cstdio>
#include <cstdlib>

namespace vile {

namespace {

constexpr int kMaxDepth = 64;

void append_utf8(std::string& out, unsigned cp) {
    if (cp < 0x80) {
        out += static_cast<char>(cp);
    } else if (cp < 0x800) {
        out += static_cast<char>(0xC0 | (cp >> 6));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        out += static_cast<char>(0xE0 | (cp >> 12));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
        out += static_cast<char>(0xF0 | (cp >> 18));
        out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    }
}

bool is_digit(char c) { return c >= '0' && c <= '9'; }

}  // namespace

struct JsonParser {
    const std::string& s;
    std::size_t i = 0;
    int depth = 0;

    explicit JsonParser(const std::string& text) : s(text) {}

    void ws() {
        while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
    }

    bool hex4(unsigned& out) {
        if (i + 4 > s.size()) return false;
        out = 0;
        for (int k = 0; k < 4; ++k) {
            char c = s[i + static_cast<std::size_t>(k)];
            out <<= 4;
            if (c >= '0' && c <= '9') out |= static_cast<unsigned>(c - '0');
            else if (c >= 'a' && c <= 'f') out |= static_cast<unsigned>(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') out |= static_cast<unsigned>(c - 'A' + 10);
            else return false;
        }
        i += 4;
        return true;
    }

    bool string_value(std::string& out) {
        if (i >= s.size() || s[i] != '"') return false;
        ++i;
        out.clear();
        while (true) {
            if (i >= s.size()) return false;
            char c = s[i++];
            if (c == '"') return true;
            if (static_cast<unsigned char>(c) < 0x20) return false;
            if (c != '\\') { out += c; continue; }
            if (i >= s.size()) return false;
            char e = s[i++];
            switch (e) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u': {
                    unsigned cp = 0;
                    if (!hex4(cp)) return false;
                    if (cp >= 0xD800 && cp < 0xDC00) {  // high surrogate: need a low one
                        if (i + 2 > s.size() || s[i] != '\\' || s[i + 1] != 'u') return false;
                        i += 2;
                        unsigned lo = 0;
                        if (!hex4(lo) || lo < 0xDC00 || lo > 0xDFFF) return false;
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                        return false;  // lone low surrogate
                    }
                    append_utf8(out, cp);
                    break;
                }
                default: return false;
            }
        }
    }

    bool number_value(Json& out) {
        std::size_t start = i;
        if (i < s.size() && s[i] == '-') ++i;
        if (i >= s.size() || !is_digit(s[i])) return false;
        while (i < s.size() && is_digit(s[i])) ++i;
        if (i < s.size() && s[i] == '.') {
            ++i;
            if (i >= s.size() || !is_digit(s[i])) return false;
            while (i < s.size() && is_digit(s[i])) ++i;
        }
        if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
            ++i;
            if (i < s.size() && (s[i] == '+' || s[i] == '-')) ++i;
            if (i >= s.size() || !is_digit(s[i])) return false;
            while (i < s.size() && is_digit(s[i])) ++i;
        }
        out.type_ = Json::Type::Number;
        out.num_ = std::strtod(s.substr(start, i - start).c_str(), nullptr);
        return true;
    }

    bool literal(const char* word) {
        std::size_t n = std::char_traits<char>::length(word);
        if (s.compare(i, n, word) != 0) return false;
        i += n;
        return true;
    }

    bool value(Json& out) {
        ws();
        if (i >= s.size() || depth > kMaxDepth) return false;
        char c = s[i];
        if (c == '{') return object(out);
        if (c == '[') return array(out);
        if (c == '"') {
            out.type_ = Json::Type::String;
            return string_value(out.str_);
        }
        if (c == 't') { out.type_ = Json::Type::Bool; out.bool_ = true; return literal("true"); }
        if (c == 'f') { out.type_ = Json::Type::Bool; out.bool_ = false; return literal("false"); }
        if (c == 'n') { out.type_ = Json::Type::Null; return literal("null"); }
        return number_value(out);
    }

    bool object(Json& out) {
        ++i;  // '{'
        ++depth;
        out.type_ = Json::Type::Object;
        ws();
        if (i < s.size() && s[i] == '}') { ++i; --depth; return true; }
        while (true) {
            ws();
            std::string key;
            if (!string_value(key)) return false;
            ws();
            if (i >= s.size() || s[i] != ':') return false;
            ++i;
            Json v;
            if (!value(v)) return false;
            out.keys_.push_back(std::move(key));
            out.items_.push_back(std::move(v));
            ws();
            if (i >= s.size()) return false;
            if (s[i] == ',') { ++i; continue; }
            if (s[i] == '}') { ++i; --depth; return true; }
            return false;
        }
    }

    bool array(Json& out) {
        ++i;  // '['
        ++depth;
        out.type_ = Json::Type::Array;
        ws();
        if (i < s.size() && s[i] == ']') { ++i; --depth; return true; }
        while (true) {
            Json v;
            if (!value(v)) return false;
            out.items_.push_back(std::move(v));
            ws();
            if (i >= s.size()) return false;
            if (s[i] == ',') { ++i; continue; }
            if (s[i] == ']') { ++i; --depth; return true; }
            return false;
        }
    }
};

std::optional<Json> Json::parse(const std::string& text) {
    JsonParser p(text);
    Json root;
    if (!p.value(root)) return std::nullopt;
    p.ws();
    if (p.i != text.size()) return std::nullopt;  // trailing garbage
    return root;
}

const Json* Json::get(const std::string& key) const {
    if (type_ != Type::Object) return nullptr;
    for (std::size_t k = 0; k < keys_.size(); ++k)
        if (keys_[k] == key) return &items_[k];
    return nullptr;
}

const Json* Json::at(std::size_t i) const {
    if (type_ != Type::Array || i >= items_.size()) return nullptr;
    return &items_[i];
}

std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof buf, "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out;
}

}  // namespace vile
