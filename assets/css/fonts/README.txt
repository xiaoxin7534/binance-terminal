把苹方字体放这里就能生效（文件名必须对得上）：

  PingFangSC-Regular.woff2
  PingFangSC-Semibold.woff2

从哪里拿：
  macOS：/System/Library/Fonts/PingFang.ttc
         用 fonttools 转成 woff2：
         pip install fonttools brotli
         python -c "from fontTools.ttLib import TTFont; f=TTFont('PingFang.ttc', fontNumber=0); f.flavor='woff2'; f.save('PingFangSC-Regular.woff2')"

注意：苹方是苹果的字体，自己电脑上用没问题，但不要随程序分发。

不想折腾的话，装一个免费的开源字体也接近：
  HarmonyOS Sans SC  https://developer.harmonyos.com/cn/design/resource
  MiSans             https://hyperos.mi.com/font
装完刷新页面即可，CSS 里已经把它们排在苹方后面。
