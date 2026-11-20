package io.github.abhishekcpp007.ludolive;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    private static final int REQUEST_MEDIA = 7;
    private static final String OFFLINE_PAGE = "file:///android_asset/offline.html";
    private static final String BG_COLOR = "#0B0C1A";

    private WebView web;
    private Uri home;
    private PermissionRequest pendingRequest;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.parseColor(BG_COLOR));
        getWindow().setNavigationBarColor(Color.parseColor(BG_COLOR));
        home = Uri.parse(Config.SERVER_URL);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor(BG_COLOR));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " LudoLiveApp/" + Config.VERSION);

        web.addJavascriptInterface(new Bridge(), "LudoAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        if (state != null) {
            web.restoreState(state);
        } else {
            web.loadUrl(home.toString());
        }
    }

    private boolean isOurs(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && home.getHost().equalsIgnoreCase(uri.getHost());
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri uri = req.getUrl();
            if (isOurs(uri)) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException ignored) {
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (req.isForMainFrame()) view.loadUrl(OFFLINE_PAGE);
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            runOnUiThread(() -> {
                if (!isOurs(request.getOrigin())) {
                    request.deny();
                    return;
                }
                List<String> needed = new ArrayList<>();
                for (String r : request.getResources()) {
                    String perm = androidPermission(r);
                    if (perm != null && checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED) needed.add(perm);
                }
                if (needed.isEmpty()) {
                    grantAllowed(request);
                } else {
                    pendingRequest = request;
                    requestPermissions(needed.toArray(new String[0]), REQUEST_MEDIA);
                }
            });
        }
    }

    private static String androidPermission(String resource) {
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) return Manifest.permission.CAMERA;
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) return Manifest.permission.RECORD_AUDIO;
        return null;
    }

    private void grantAllowed(PermissionRequest request) {
        List<String> ok = new ArrayList<>();
        for (String r : request.getResources()) {
            String perm = androidPermission(r);
            if (perm != null && checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED) ok.add(r);
        }
        if (ok.isEmpty()) request.deny();
        else request.grant(ok.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (code != REQUEST_MEDIA || pendingRequest == null) return;
        grantAllowed(pendingRequest);
        pendingRequest = null;
    }

    private class Bridge {
        @JavascriptInterface
        public void share(String text) {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_TEXT, text);
            runOnUiThread(() -> startActivity(Intent.createChooser(send, "Invite to Ludo Live")));
        }

        @JavascriptInterface
        public void retry() {
            runOnUiThread(() -> web.loadUrl(home.toString()));
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
