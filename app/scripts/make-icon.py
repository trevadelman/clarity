"""Generate the Clarity app icon: a purple gradient rounded square with a
white video-camera glyph, matching the in-app nav logo. Outputs a 1024x1024
PNG suitable for `tauri icon`."""

from PIL import Image, ImageDraw

SIZE = 1024
# Gradient endpoints matching the nav logo (135deg: --accent -> #9b7bff).
C0 = (109, 94, 252)   # #6d5efc
C1 = (155, 123, 255)  # #9b7bff


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def diagonal_gradient(size, c0, c1):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            # 135deg diagonal: normalize (x+y) across the full diagonal.
            t = (x + y) / (2 * (size - 1))
            px[x, y] = lerp(c0, c1, t)
    return img


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def main():
    grad = diagonal_gradient(SIZE, C0, C1)
    mask = rounded_mask(SIZE, radius=round(SIZE * 0.225))

    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(icon)
    white = (255, 255, 255, 255)

    # Video-camera glyph (lucide "video"): rounded body + lens triangle.
    body_w = round(SIZE * 0.34)
    body_h = round(SIZE * 0.30)
    body_x = round(SIZE * 0.26)
    body_y = (SIZE - body_h) // 2
    d.rounded_rectangle(
        [body_x, body_y, body_x + body_w, body_y + body_h],
        radius=round(body_h * 0.28),
        fill=white,
    )

    # Lens: a triangle pointing right, joined to the body.
    lens_x = body_x + body_w - round(SIZE * 0.01)
    cy = body_y + body_h / 2
    lens_w = round(SIZE * 0.17)
    lens_h = round(body_h * 0.78)
    d.polygon(
        [
            (lens_x, cy - lens_h * 0.18),
            (lens_x, cy + lens_h * 0.18),
            (lens_x + lens_w, cy + lens_h / 2),
            (lens_x + lens_w, cy - lens_h / 2),
        ],
        fill=white,
    )

    out = "src-tauri/icons/source-icon.png"
    icon.save(out)
    print("wrote", out)


if __name__ == "__main__":
    main()
