package ru.appswire.novpn.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size as GSize
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import kotlinx.coroutines.delay
import java.net.URLDecoder
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Сканирование QR-кода подписки.
 *
 * Своя камера (CameraX) и распознавание ZXing, а не сканер Google Play Services:
 * тот не работает на телефонах без сервисов Google, а VPN-клиент как раз часто
 * ставят на такие. Разрешение на камеру спрашиваем только по нажатию кнопки.
 */
object QrLink {

    /**
     * Ссылка-подписка из текста QR-кода или null, если там что-то другое.
     *
     * Понимаем то, что показывает панель: прямую https-ссылку (/sub/…, /k/…) и
     * ссылку приложения novpn://subscribe?url=…. Конфиги других клиентов
     * (vless://, конфиг AmneziaWG) — не подписка, их не принимаем.
     */
    fun extract(text: String): String? {
        val t = text.trim()
        if (t.startsWith("novpn:", ignoreCase = true)) {
            // Разбираем руками, без android.net.Uri — так функция проверяется юнит-тестом.
            val raw = t.substringAfter('?', "").split('&')
                .firstOrNull { it.startsWith("url=") }?.substringAfter("url=")
                ?: return null
            val inner = runCatching { URLDecoder.decode(raw, "UTF-8") }.getOrDefault(raw).trim()
            return inner.takeIf { isHttps(it) && !it.any(Char::isWhitespace) }
        }
        return t.takeIf { isHttps(it) && !it.any(Char::isWhitespace) }
    }

    private fun isHttps(s: String) = s.startsWith("https://", ignoreCase = true)
}

/**
 * Кнопка-значок сканера для правого края поля ввода ссылки.
 * На устройствах без камеры не рисуется вовсе.
 *
 * @param onLink вызывается с готовой ссылкой после удачного сканирования.
 * @param onError текст для человека, если камера недоступна или не разрешена.
 */
@Composable
fun QrScanButton(onLink: (String) -> Unit, onError: (String) -> Unit) {
    val c = NoVpnTheme.colors
    val context = LocalContext.current
    val hasCamera = remember {
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
    }
    if (!hasCamera) return

    var open by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            open = true
        } else {
            onError("Нет доступа к камере. Разрешите его в настройках телефона или вставьте ссылку вручную.")
        }
    }

    Box(
        modifier = Modifier
            .size(30.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable {
                val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                    PackageManager.PERMISSION_GRANTED
                if (granted) open = true else permission.launch(Manifest.permission.CAMERA)
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(NoVpnIcons.Scan, contentDescription = "Сканировать QR-код", tint = c.accentLight, modifier = Modifier.size(22.dp))
    }

    if (open) {
        QrScannerDialog(
            onClose = { open = false },
            onLink = {
                open = false
                onLink(it)
            },
        )
    }
}

/** Полноэкранный видоискатель: камера, затемнение с окном, уголки, развёртка. */
@Composable
private fun QrScannerDialog(onClose: () -> Unit, onLink: (String) -> Unit) {
    Dialog(
        onDismissRequest = onClose,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        val c = NoVpnTheme.colors
        val context = LocalContext.current
        val lifecycleOwner = LocalLifecycleOwner.current
        var hint by remember { mutableStateOf<String?>(null) }
        var camera by remember { mutableStateOf<Camera?>(null) }
        var torch by remember { mutableStateOf(false) }
        val done = remember { AtomicBoolean(false) }
        val previewView = remember {
            PreviewView(context).apply {
                implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                scaleType = PreviewView.ScaleType.FILL_CENTER
            }
        }

        // Подсказка «это не подписка» гаснет сама, пока человек ищет нужный код.
        LaunchedEffect(hint) {
            if (hint != null) {
                delay(2500)
                hint = null
            }
        }

        DisposableEffect(lifecycleOwner) {
            val executor = Executors.newSingleThreadExecutor()
            val main = Handler(Looper.getMainLooper())
            val future = ProcessCameraProvider.getInstance(context)
            var provider: ProcessCameraProvider? = null
            future.addListener({
                val p = runCatching { future.get() }.getOrNull()
                if (p == null) {
                    hint = "Камера недоступна"
                    return@addListener
                }
                provider = p
                val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setResolutionSelector(
                        ResolutionSelector.Builder()
                            .setResolutionStrategy(
                                ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER),
                            )
                            .build(),
                    )
                    .build()
                val reader = MultiFormatReader().apply {
                    setHints(
                        mapOf(
                            DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                            DecodeHintType.TRY_HARDER to true,
                        ),
                    )
                }
                analysis.setAnalyzer(executor) { image ->
                    val text = image.use { decode(reader, it) }
                    if (text != null && !done.get()) {
                        main.post {
                            if (done.get()) return@post
                            val link = QrLink.extract(text)
                            if (link != null) {
                                done.set(true)
                                onLink(link)
                            } else {
                                hint = "Это не ссылка-подписка NoVPN"
                            }
                        }
                    }
                }
                runCatching {
                    p.unbindAll()
                    camera = p.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                }.onFailure { hint = "Не удалось открыть камеру" }
            }, ContextCompat.getMainExecutor(context))

            onDispose {
                runCatching { provider?.unbindAll() }
                executor.shutdown()
            }
        }

        Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
            AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
            ScanOverlay(accent = c.accentLight)

            Column(
                modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Row(modifier = Modifier.fillMaxWidth().padding(12.dp)) {
                    RoundIcon(NoVpnIcons.Close, "Закрыть", onClick = onClose)
                }
                Spacer(Modifier.weight(1f))
                Text(
                    "Наведите камеру на QR-код подписки",
                    color = Color.White,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(horizontal = 32.dp),
                )
                Text(
                    hint ?: "Его показывают в личном кабинете и в письме со ссылкой.",
                    color = if (hint != null) c.amberFg else Color.White.copy(alpha = 0.7f),
                    fontSize = 13.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(start = 32.dp, end = 32.dp, top = 6.dp),
                )
                val hasFlash = camera?.cameraInfo?.hasFlashUnit() == true
                Box(modifier = Modifier.height(96.dp), contentAlignment = Alignment.Center) {
                    if (hasFlash) {
                        RoundIcon(
                            NoVpnIcons.Torch,
                            if (torch) "Выключить фонарик" else "Включить фонарик",
                            active = torch,
                            onClick = {
                                torch = !torch
                                camera?.cameraControl?.enableTorch(torch)
                            },
                        )
                    }
                }
            }
        }
    }
}

/** Затемнение с прозрачным окном, акцентные уголки и бегущая линия развёртки. */
@Composable
private fun ScanOverlay(accent: Color) {
    val sweep by rememberInfiniteTransition(label = "scan").animateFloat(
        initialValue = 0.08f,
        targetValue = 0.92f,
        animationSpec = infiniteRepeatable(tween(1800, easing = LinearEasing), RepeatMode.Reverse),
        label = "sweep",
    )
    Canvas(
        modifier = Modifier
            .fillMaxSize()
            // Offscreen — чтобы BlendMode.Clear вырезал окно в затемнении, а не в камере.
            .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen),
    ) {
        val side = minOf(size.width, size.height) * 0.68f
        val left = (size.width - side) / 2f
        val top = size.height * 0.42f - side / 2f
        val radius = 22.dp.toPx()

        drawRect(Color.Black.copy(alpha = 0.58f))
        drawRoundRect(
            color = Color.Transparent,
            topLeft = Offset(left, top),
            size = GSize(side, side),
            cornerRadius = CornerRadius(radius),
            blendMode = BlendMode.Clear,
        )

        // Уголки: четыре дуги-скобки поверх краёв окна.
        val stroke = Stroke(width = 4.dp.toPx(), cap = StrokeCap.Round)
        val arm = side * 0.16f
        val right = left + side
        val bottom = top + side
        fun corner(x: Float, y: Float, dx: Float, dy: Float) {
            drawLine(accent, Offset(x, y + dy * radius), Offset(x, y + dy * (radius + arm)), strokeWidth = stroke.width, cap = StrokeCap.Round)
            drawLine(accent, Offset(x + dx * radius, y), Offset(x + dx * (radius + arm), y), strokeWidth = stroke.width, cap = StrokeCap.Round)
            drawArc(
                color = accent,
                startAngle = when {
                    dx > 0 && dy > 0 -> 180f
                    dx < 0 && dy > 0 -> 270f
                    dx < 0 && dy < 0 -> 0f
                    else -> 90f
                },
                sweepAngle = 90f,
                useCenter = false,
                topLeft = Offset(if (dx > 0) x else x - 2 * radius, if (dy > 0) y else y - 2 * radius),
                size = GSize(2 * radius, 2 * radius),
                style = stroke,
            )
        }
        corner(left, top, 1f, 1f)
        corner(right, top, -1f, 1f)
        corner(right, bottom, -1f, -1f)
        corner(left, bottom, 1f, -1f)

        // Развёртка: мягкая полоса, гаснущая к краям.
        val y = top + side * sweep
        drawLine(
            brush = Brush.horizontalGradient(
                listOf(Color.Transparent, accent.copy(alpha = 0.9f), Color.Transparent),
                startX = left + radius,
                endX = right - radius,
            ),
            start = Offset(left + radius, y),
            end = Offset(right - radius, y),
            strokeWidth = 2.dp.toPx(),
        )
    }
}

@Composable
private fun RoundIcon(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, active: Boolean = false, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(48.dp)
            .clip(CircleShape)
            .background(if (active) Color.White else Color.Black.copy(alpha = 0.45f))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = label, tint = if (active) Color.Black else Color.White, modifier = Modifier.size(22.dp))
    }
}

/** Яркостная плоскость кадра → текст QR или null. */
private fun decode(reader: MultiFormatReader, image: ImageProxy): String? {
    val plane = image.planes.firstOrNull() ?: return null
    val buffer = plane.buffer
    val data = ByteArray(buffer.remaining())
    buffer.get(data)
    val source = PlanarYUVLuminanceSource(
        data, plane.rowStride, image.height, 0, 0, image.width, image.height, false,
    )
    return try {
        reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
    } catch (_: Exception) {
        null
    } finally {
        reader.reset()
    }
}
