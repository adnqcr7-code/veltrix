#pragma once
// Tiny HTTP/1.1 client that can ONLY talk to this computer (loopback). It is the
// only network code the AI feature uses, so AI traffic cannot leave the machine
// through VILE even if a setting is tampered with.
#include <string>

namespace vile {

struct HttpResponse {
    int status = 0;
    std::string body;
    std::string error;  // empty on success
    bool ok() const { return error.empty() && status >= 200 && status < 300; }
};

class HttpTransport {
public:
    virtual ~HttpTransport() = default;
    virtual HttpResponse request(const std::string& method, const std::string& host, int port,
                                 const std::string& path, const std::string& body, int timeout_ms) = 0;
};

bool is_loopback_host(const std::string& host);  // "127.0.0.1", "localhost", "::1"

class LoopbackHttp : public HttpTransport {
public:
    // timeout_ms applies to connecting/sending and to each wait for data.
    // Non-loopback hosts are refused without opening a socket.
    HttpResponse request(const std::string& method, const std::string& host, int port,
                         const std::string& path, const std::string& body, int timeout_ms) override;
};

}  // namespace vile
