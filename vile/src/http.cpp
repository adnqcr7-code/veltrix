#include "vile/http.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <optional>

namespace vile {

bool is_loopback_host(const std::string& host) {
    return host == "127.0.0.1" || host == "localhost" || host == "::1";
}

namespace {

constexpr std::size_t kMaxResponse = 16 * 1024 * 1024;

struct Fd {
    int fd = -1;
    ~Fd() { if (fd >= 0) ::close(fd); }
};

std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
    return s;
}

// Decodes a chunked body. Returns true once the terminating chunk has arrived.
bool decode_chunked(const std::string& in, std::string& out) {
    out.clear();
    std::size_t i = 0;
    while (true) {
        std::size_t eol = in.find("\r\n", i);
        if (eol == std::string::npos) return false;
        std::string size_str = in.substr(i, eol - i);
        std::size_t semi = size_str.find(';');
        if (semi != std::string::npos) size_str.resize(semi);
        char* end = nullptr;
        unsigned long sz = std::strtoul(size_str.c_str(), &end, 16);
        if (end == size_str.c_str()) return false;
        i = eol + 2;
        if (sz == 0) return true;  // trailers, if any, are ignored
        if (in.size() < i + sz + 2) return false;
        out.append(in, i, sz);
        i += sz + 2;
    }
}

}  // namespace

HttpResponse LoopbackHttp::request(const std::string& method, const std::string& host, int port,
                                   const std::string& path, const std::string& body, int timeout_ms) {
    HttpResponse r;
    if (!is_loopback_host(host)) { r.error = "refused: only this computer is allowed"; return r; }
    if (port <= 0 || port > 65535) { r.error = "invalid port"; return r; }

    const bool v6 = host == "::1";
    Fd sock;
    sock.fd = ::socket(v6 ? AF_INET6 : AF_INET, SOCK_STREAM, 0);
    if (sock.fd < 0) { r.error = "could not create socket"; return r; }

    timeval tv{};
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;
    setsockopt(sock.fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(sock.fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);

    int rc;
    if (v6) {
        sockaddr_in6 a{};
        a.sin6_family = AF_INET6;
        a.sin6_port = htons(static_cast<uint16_t>(port));
        a.sin6_addr = in6addr_loopback;
        rc = ::connect(sock.fd, reinterpret_cast<sockaddr*>(&a), sizeof a);
    } else {
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_port = htons(static_cast<uint16_t>(port));
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        rc = ::connect(sock.fd, reinterpret_cast<sockaddr*>(&a), sizeof a);
    }
    if (rc != 0) { r.error = std::string("connect failed: ") + std::strerror(errno); return r; }

    std::string req = method + " " + path + " HTTP/1.1\r\nHost: " + host + ":" + std::to_string(port) +
                      "\r\nConnection: close\r\nAccept: application/json\r\n";
    if (method == "POST" || !body.empty())
        req += "Content-Type: application/json\r\nContent-Length: " + std::to_string(body.size()) + "\r\n";
    req += "\r\n" + body;

    for (std::size_t sent = 0; sent < req.size();) {
        ssize_t n = ::send(sock.fd, req.data() + sent, req.size() - sent, MSG_NOSIGNAL);
        if (n < 0) {
            if (errno == EINTR) continue;
            r.error = std::string("send failed: ") + std::strerror(errno);
            return r;
        }
        sent += static_cast<std::size_t>(n);
    }

    std::string raw;
    std::size_t header_end = std::string::npos;
    bool chunked = false;
    std::optional<std::size_t> content_length;
    char buf[8192];

    while (true) {
        ssize_t n = ::recv(sock.fd, buf, sizeof buf, 0);
        if (n < 0) {
            if (errno == EINTR) continue;
            r.error = (errno == EAGAIN || errno == EWOULDBLOCK) ? "timed out waiting for a reply"
                                                                 : std::string("recv failed: ") + std::strerror(errno);
            return r;
        }
        if (n == 0) break;  // server closed: response is complete
        raw.append(buf, static_cast<std::size_t>(n));
        if (raw.size() > kMaxResponse) { r.error = "response too large"; return r; }

        if (header_end == std::string::npos) {
            header_end = raw.find("\r\n\r\n");
            if (header_end != std::string::npos) {
                std::string head = lower(raw.substr(0, header_end));
                if (head.find("transfer-encoding: chunked") != std::string::npos) chunked = true;
                std::size_t cl = head.find("content-length:");
                if (cl != std::string::npos)
                    content_length = static_cast<std::size_t>(std::strtoull(head.c_str() + cl + 15, nullptr, 10));
            }
        }
        if (header_end != std::string::npos) {
            std::size_t body_start = header_end + 4;
            if (chunked) {
                std::string tmp;
                if (decode_chunked(raw.substr(body_start), tmp)) break;
            } else if (content_length && raw.size() - body_start >= *content_length) {
                break;
            }
        }
    }

    if (header_end == std::string::npos) { r.error = "malformed reply"; return r; }
    if (raw.compare(0, 5, "HTTP/") != 0 || raw.size() < 12) { r.error = "malformed reply"; return r; }
    r.status = std::atoi(raw.c_str() + raw.find(' ') + 1);

    std::string rest = raw.substr(header_end + 4);
    if (chunked) {
        if (!decode_chunked(rest, r.body)) { r.error = "incomplete reply"; return r; }
    } else if (content_length) {
        r.body = rest.substr(0, std::min(rest.size(), *content_length));
    } else {
        r.body = std::move(rest);
    }
    return r;
}

}  // namespace vile
