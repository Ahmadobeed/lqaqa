const nodemailer = require("nodemailer");
exports.handler = async (event) => {
  try {
    const { email } = JSON.parse(event.body);
    const code = Math.floor(10000 + Math.random() * 90000);
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
    await transporter.sendMail({
      from: `"القعقاع | Al-Qaqa" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: "رمز استرداد الحساب - القعقاع | Al-Qaqa",
      html: `<div dir="rtl" style="font-family:Arial; text-align:center; padding:30px; background:#0A1120; color:#fff;"><h2>القعقاع | Al-Qaqa</h2><p>السلام عليكم ورحمة الله تعالى وبركاته<br>حياكم الله جميعا</p><p>رمز استرداد الحساب</p><h1 style="font-size:50px; letter-spacing:12px; color:#3A86FF;">${code}</h1><p>جزاكم الله خيرا<br>لاتنسونا من صالح دعائكم<br>المطور: زمزم أبو القعقاع</p></div>`
    });
    return { statusCode: 200, body: JSON.stringify({ success: true, code }) };
  } catch (e) { return { statusCode: 500, body: JSON.stringify({ error: e.message }) }; }
};
