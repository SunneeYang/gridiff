package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

//go:embed assets/*
var assetsFS embed.FS

var version = "dev"

const maxBytes = 8 * 1024 * 1024
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

type snapshot struct {
	Sources []string `json:"sources"`
	Title   string   `json:"title"`
	XLSX    bool     `json:"xlsx"`
	Inputs  []string `json:"inputs"`
	Error   string   `json:"error,omitempty"`
}

type preferences struct {
	Mode    string `json:"mode"`
	Palette string `json:"palette"`
}

var defaultPreferences = preferences{Mode: "system", Palette: "default"}

type serverOptions struct {
	Files      []string
	ConfigPath string
	Startup    time.Duration
	Idle       time.Duration
}

type comparisonServer struct {
	URL        string
	origin     string
	prefix     string
	configPath string
	idle       time.Duration
	http       *http.Server
	mu         sync.Mutex
	data       *snapshot
	timer      *time.Timer
	closing    bool
	done       chan struct{}
	once       sync.Once
}

func readSnapshot(file string) ([]byte, error) {
	if file == os.DevNull {
		return nil, nil
	}
	info, err := os.Stat(file)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("请选择普通文件：%s", file)
	}
	if info.Size() > maxBytes {
		return nil, errors.New("单侧文件超过 8 MiB，请缩小表格")
	}
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxBytes {
		return nil, errors.New("单侧文件超过 8 MiB，请缩小表格")
	}
	return data, nil
}

func makeSnapshot(files []string) (*snapshot, error) {
	if len(files) != 2 || files[0] == "" || files[1] == "" {
		return nil, errors.New("需要旧版本和新版本两个文件")
	}
	result := &snapshot{Sources: make([]string, 2), Inputs: make([]string, 2)}
	buffers := make([][]byte, 2)
	kinds := make([]string, 2)
	for i, file := range files {
		absolute, err := filepath.Abs(file)
		if err != nil {
			return nil, err
		}
		result.Sources[i] = absolute
		buffers[i], err = readSnapshot(absolute)
		if err != nil {
			return nil, err
		}
		ext := strings.ToLower(filepath.Ext(absolute))
		if ext == ".xlsx" {
			result.XLSX = true
		}
		if len(buffers[i]) == 0 {
			continue
		}
		if ext == ".xlsx" || bytes.HasPrefix(buffers[i], []byte{'P', 'K', 3, 4}) {
			kinds[i] = "xlsx"
			result.XLSX = true
		} else if ext == ".xls" || ext == ".xlsb" || ext == ".ods" {
			return nil, errors.New("目前支持 CSV 和 XLSX，不支持 XLS、XLSB 或 ODS")
		} else {
			kinds[i] = "csv"
		}
	}
	if (kinds[0] == "xlsx" && kinds[1] == "csv") || (kinds[1] == "xlsx" && kinds[0] == "csv") {
		return nil, errors.New("请选择两份 CSV 或两份 XLSX；暂不支持混合比较")
	}
	for i, data := range buffers {
		if result.XLSX {
			if len(data) > 0 {
				if err := validateArchive(data); err != nil {
					result.Error = "无法读取 XLSX：" + err.Error()
					result.Inputs = []string{"", ""}
					break
				}
			}
			result.Inputs[i] = base64.StdEncoding.EncodeToString(data)
		} else {
			if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
				return nil, errors.New("CSV 必须是 UTF-8 文本，请检查文件编码或格式")
			}
			result.Inputs[i] = string(data)
		}
	}
	result.Title = filepath.Base(result.Sources[1])
	return result, nil
}

func startServer(options serverOptions) (*comparisonServer, error) {
	data, err := makeSnapshot(options.Files)
	if err != nil {
		return nil, err
	}
	if options.ConfigPath == "" {
		directory, err := os.UserConfigDir()
		if err != nil {
			return nil, err
		}
		options.ConfigPath = filepath.Join(directory, "gridiff", "preferences.json")
	}
	if options.Startup <= 0 {
		options.Startup = 2 * time.Minute
	}
	if options.Idle <= 0 {
		options.Idle = 10 * time.Minute
	}
	token := make([]byte, 24)
	if _, err := rand.Read(token); err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &comparisonServer{origin: "http://" + listener.Addr().String(), prefix: "/s/" + hex.EncodeToString(token) + "/", configPath: options.ConfigPath, data: data, idle: options.Idle, done: make(chan struct{})}
	s.URL = s.origin + s.prefix
	s.http = &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	s.mu.Lock()
	s.timer = time.AfterFunc(options.Startup, s.Close)
	s.mu.Unlock()
	go func() { _ = s.http.Serve(listener); s.Close() }()
	return s, nil
}

func (s *comparisonServer) touch() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closing {
		s.timer.Reset(s.idle)
	}
}

func (s *comparisonServer) Close() {
	s.once.Do(func() {
		s.mu.Lock()
		s.closing = true
		s.data = nil
		s.timer.Stop()
		s.mu.Unlock()
		_ = s.http.Close()
		close(s.done)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func failHTTP(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func readObject(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, error) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return nil, errors.New("请求必须使用 JSON")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 65536)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	var value map[string]json.RawMessage
	if err := decoder.Decode(&value); err != nil {
		return nil, errors.New("请求内容无效或过大")
	}
	if value == nil {
		return nil, errors.New("请求内容无效")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, errors.New("请求内容无效")
	}
	return value, nil
}

func validPreferences(p preferences) bool {
	return (p.Mode == "system" || p.Mode == "light" || p.Mode == "dark") &&
		(p.Palette == "default" || p.Palette == "github" || p.Palette == "catppuccin" || p.Palette == "solarized" || p.Palette == "nord")
}

func loadPreferences(file string) preferences {
	f, err := os.Open(file)
	if err != nil {
		return defaultPreferences
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 4097))
	var p preferences
	if err != nil || len(data) > 4096 || json.Unmarshal(data, &p) != nil || !validPreferences(p) {
		return defaultPreferences
	}
	return p
}

func savePreferences(file string, p preferences) error {
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(file), ".preferences-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err := json.NewEncoder(f).Encode(p); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(name, file)
}

func (s *comparisonServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Security-Policy", csp)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	if r.Host != strings.TrimPrefix(s.origin, "http://") || (r.Header.Get("Origin") != "" && r.Header.Get("Origin") != s.origin) ||
		(r.Header.Get("Sec-Fetch-Site") != "" && r.Header.Get("Sec-Fetch-Site") != "none" && r.Header.Get("Sec-Fetch-Site") != "same-origin") {
		failHTTP(w, 403, "仅允许本地比较页面访问")
		return
	}
	s.mu.Lock()
	closing, data := s.closing, s.data
	s.mu.Unlock()
	if closing {
		failHTTP(w, 410, "比较会话已结束")
		return
	}
	if !strings.HasPrefix(r.URL.Path, s.prefix) || r.URL.RawQuery != "" || r.URL.EscapedPath() != r.URL.Path {
		failHTTP(w, 404, "比较会话不存在")
		return
	}
	route := strings.TrimPrefix(r.URL.Path, s.prefix)
	if r.Method == http.MethodGet {
		switch route {
		case "snapshot":
			s.touch()
			writeJSON(w, 200, data)
		case "preferences":
			writeJSON(w, 200, loadPreferences(s.configPath))
		default:
			if route == "" {
				route = "index.html"
				s.touch()
			}
			serveAsset(w, r, route)
		}
		return
	}
	if r.Method != http.MethodPost || (route != "heartbeat" && route != "close" && route != "preferences") {
		failHTTP(w, 405, "请求方式无效")
		return
	}
	object, err := readObject(w, r)
	if err != nil {
		failHTTP(w, 400, err.Error())
		return
	}
	if route == "preferences" {
		var p preferences
		if len(object) != 2 || json.Unmarshal(object["mode"], &p.Mode) != nil || json.Unmarshal(object["palette"], &p.Palette) != nil || !validPreferences(p) {
			failHTTP(w, 400, "主题设置无效")
			return
		}
		if err := savePreferences(s.configPath, p); err != nil {
			failHTTP(w, 500, "无法保存主题设置："+err.Error())
			return
		}
		s.touch()
		writeJSON(w, 200, p)
		return
	}
	if len(object) != 0 {
		failHTTP(w, 400, "请求内容无效")
		return
	}
	if route == "heartbeat" {
		s.touch()
		w.WriteHeader(204)
		return
	}
	w.WriteHeader(204)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	go s.Close()
}

func asset(name string) ([]byte, error) {
	switch name {
	case "index.html", "main.js", "main.css", "browser.js", "worker.js", "themes.js", "themes.css", "licenses.txt":
		return assetsFS.ReadFile("assets/" + name + ".gz")
	default:
		return nil, os.ErrNotExist
	}
}

func serveAsset(w http.ResponseWriter, r *http.Request, name string) {
	data, err := asset(name)
	if err != nil {
		failHTTP(w, 404, "页面不存在")
		return
	}
	contentType := "text/plain; charset=utf-8"
	switch filepath.Ext(name) {
	case ".html":
		contentType = "text/html; charset=utf-8"
	case ".js":
		contentType = "text/javascript; charset=utf-8"
	case ".css":
		contentType = "text/css; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Vary", "Accept-Encoding")
	for _, encoding := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		parts := strings.Split(strings.TrimSpace(encoding), ";")
		if parts[0] == "gzip" && (len(parts) == 1 || strings.TrimSpace(parts[1]) != "q=0") {
			w.Header().Set("Content-Encoding", "gzip")
			_, _ = w.Write(data)
			return
		}
	}
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		failHTTP(w, 500, "页面资源损坏")
		return
	}
	defer reader.Close()
	_, _ = io.Copy(w, reader)
}

func waitServer(s *comparisonServer) {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	select {
	case <-s.done:
	case <-ctx.Done():
		s.Close()
	}
}

func background(files []string) (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	command := exec.Command(executable, "--serve")
	detach(command)
	input, _ := json.Marshal(struct {
		Files []string `json:"files"`
	}{files})
	command.Stdin = bytes.NewReader(input)
	output, err := command.StdoutPipe()
	if err != nil {
		return "", err
	}
	if err := command.Start(); err != nil {
		return "", err
	}
	type answer struct {
		URL   string `json:"url"`
		Error string `json:"error"`
	}
	ch := make(chan struct {
		value answer
		err   error
	}, 1)
	go func() {
		var value answer
		err := json.NewDecoder(io.LimitReader(bufio.NewReader(output), 8192)).Decode(&value)
		ch <- struct {
			value answer
			err   error
		}{value, err}
	}()
	var response answer
	select {
	case result := <-ch:
		response, err = result.value, result.err
	case <-time.After(time.Minute):
		err = errors.New("启动本地比较服务超时")
	}
	_ = output.Close()
	if err == nil && response.Error != "" {
		err = errors.New(response.Error)
	}
	if err == nil {
		u, parseErr := url.Parse(response.URL)
		if parseErr != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || !strings.HasPrefix(u.Path, "/s/") {
			err = errors.New("比较服务响应无效")
		}
	}
	if err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		return "", err
	}
	_ = command.Process.Release()
	return response.URL, nil
}

func openBrowser(address string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("/usr/bin/open", address)
	case "windows":
		command = exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", address)
	default:
		command = exec.Command("xdg-open", address)
	}
	if err := command.Start(); err != nil {
		return err
	}
	finished := make(chan error, 1)
	go func() { finished <- command.Wait() }()
	select {
	case err := <-finished:
		return err
	case <-time.After(2 * time.Second):
		return nil
	}
}

func run(args []string) error {
	if len(args) == 1 && args[0] == "--serve" {
		var request struct {
			Files []string `json:"files"`
		}
		var s *comparisonServer
		err := json.NewDecoder(io.LimitReader(os.Stdin, 65537)).Decode(&request)
		if err == nil {
			s, err = startServer(serverOptions{Files: request.Files})
		}
		if err != nil {
			_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"error": err.Error()})
			return err
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"url": s.URL})
		waitServer(s)
		return nil
	}
	if len(args) == 0 || (len(args) == 1 && (args[0] == "--help" || args[0] == "-h")) || (len(args) == 2 && args[0] == "diff" && (args[1] == "--help" || args[1] == "-h")) {
		fmt.Printf("Gridiff %s — 本地浏览器表格对比\n\n用法：gridiff [--no-open] [--wait] <旧文件> <新文件>\n\nFork 自定义外部 Diff：选择 gridiff，Arguments 保持默认 $LOCAL $REMOTE。\n兼容旧用法：gridiff diff <旧文件> <新文件>。\n支持 CSV 和 XLSX，只读比较，自动打开默认浏览器。\n数据保存在内存，不生成 HTML 或数据临时文件。\n\n  --no-open   仅打印地址，不打开浏览器\n  --wait      等待结束比较或超时后退出\n  --version   显示版本\n  --licenses  显示许可声明\n  --help      显示帮助\n\n默认完成文件快照后返回；未打开页面时 2 分钟退出，失去心跳后 10 分钟退出。\n", version)
		return nil
	}
	if len(args) == 1 && args[0] == "--version" {
		fmt.Println(version)
		return nil
	}
	if len(args) == 1 && args[0] == "--licenses" {
		data, err := asset("licenses.txt")
		if err != nil {
			return err
		}
		reader, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return err
		}
		defer reader.Close()
		_, err = io.Copy(os.Stdout, reader)
		return err
	}
	if args[0] == "diff" {
		args = args[1:]
	}
	var files []string
	noOpen, wait, literal := false, false, false
	for _, arg := range args {
		if !literal {
			switch arg {
			case "--":
				literal = true
				continue
			case "--no-open":
				noOpen = true
				continue
			case "--wait":
				wait = true
				continue
			}
		}
		if !literal && strings.HasPrefix(arg, "-") {
			return fmt.Errorf("未知选项：%s", arg)
		}
		absolute, err := filepath.Abs(arg)
		if err != nil {
			return err
		}
		files = append(files, absolute)
	}
	if len(files) != 2 {
		return errors.New("请选择旧版本和新版本两个文件")
	}
	var address string
	var s *comparisonServer
	var err error
	if wait {
		s, err = startServer(serverOptions{Files: files})
		if err == nil {
			address = s.URL
		}
	} else {
		address, err = background(files)
	}
	if err != nil {
		return err
	}
	fmt.Println(address)
	if !noOpen {
		if err := openBrowser(address); err != nil {
			fmt.Fprintln(os.Stderr, "未能自动打开浏览器，请手动打开上面的本地地址。")
		}
	}
	if s != nil {
		waitServer(s)
	}
	return nil
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "Gridiff:", err)
		os.Exit(1)
	}
}
