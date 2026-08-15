// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Arabic (`ar`).
class AppLocalizationsAr extends AppLocalizations {
  AppLocalizationsAr([String locale = 'ar']) : super(locale);

  @override
  String get appName => 'BluelineGPT';

  @override
  String get startup => 'جارٍ تشغيل BluelineGPT…';

  @override
  String get retry => 'إعادة المحاولة';

  @override
  String get somethingWentWrong => 'حدث خطأ ما';

  @override
  String get serviceUnavailable => 'الخدمة غير متاحة حالياً.';

  @override
  String get login => 'تسجيل الدخول';

  @override
  String get identifier =>
      'اسم المستخدم أو البريد الإلكتروني أو رقم الهاتف المتحرك';

  @override
  String get password => 'كلمة المرور';

  @override
  String get showPassword => 'إظهار كلمة المرور';

  @override
  String get hidePassword => 'إخفاء كلمة المرور';

  @override
  String get invalidCredentials =>
      'معرّف تسجيل الدخول أو كلمة المرور غير صحيحة.';

  @override
  String get loginUnavailable =>
      'تعذر تسجيل الدخول الآن. يرجى المحاولة مرة أخرى.';

  @override
  String get unsupportedRole =>
      'حسابك نشط، ولكن هذا الدور غير مدعوم بعد في تطبيق الهاتف المتحرك.';

  @override
  String get missingCompany => 'تعذر التحقق من صلاحية الوصول إلى الشركة.';

  @override
  String get missingProfile => 'تعذر التحقق من ملف العمل المرتبط بحسابك.';

  @override
  String get accountUnavailable =>
      'لا يمكن لهذا الحساب الوصول إلى تطبيق الهاتف المتحرك.';

  @override
  String get forgotPasswordUnavailable =>
      'استعادة كلمة المرور غير متاحة بعد. يرجى التواصل مع مسؤول الشركة أو الدعم.';

  @override
  String get forgotPassword => 'نسيت كلمة المرور';

  @override
  String get dashboard => 'لوحة المعلومات';

  @override
  String get orders => 'الطلبات';

  @override
  String get orderDetails => 'تفاصيل الطلب';

  @override
  String get createOrder => 'إنشاء طلب';

  @override
  String get myOrders => 'طلباتي';

  @override
  String get trackOrder => 'تتبع الطلب';

  @override
  String get messages => 'الرسائل';

  @override
  String get notifications => 'الإشعارات';

  @override
  String get profile => 'الملف الشخصي';

  @override
  String get settings => 'الإعدادات';

  @override
  String get account => 'الحساب';

  @override
  String get signedInAs => 'تم تسجيل الدخول باسم';

  @override
  String get role => 'الدور';

  @override
  String get trader => 'تاجر';

  @override
  String get driver => 'سائق';

  @override
  String get operator => 'مشغّل';

  @override
  String get customer => 'عميل';

  @override
  String get appVersion => 'إصدار التطبيق';

  @override
  String get helpSupport => 'المساعدة والدعم';

  @override
  String get privacyPolicy => 'سياسة الخصوصية';

  @override
  String get termsConditions => 'الشروط والأحكام';

  @override
  String get changePassword => 'تغيير كلمة المرور';

  @override
  String get currentPassword => 'كلمة المرور الحالية';

  @override
  String get newPassword => 'كلمة المرور الجديدة';

  @override
  String get savePassword => 'حفظ كلمة المرور';

  @override
  String get passwordMinimum => 'استخدم 8 أحرف على الأقل.';

  @override
  String get passwordChanged => 'تم تغيير كلمة المرور بنجاح.';

  @override
  String get passwordChangeFailed => 'تعذر تغيير كلمة المرور.';

  @override
  String get logout => 'تسجيل الخروج';

  @override
  String get logoutConfirm => 'هل تريد تسجيل الخروج من BluelineGPT؟';

  @override
  String get cancel => 'إلغاء';

  @override
  String get welcome => 'مرحباً';

  @override
  String get lastUpdated => 'آخر تحديث';

  @override
  String get notAvailable => 'غير متاح';

  @override
  String get dataUnavailable => 'البيانات غير متاحة حالياً.';

  @override
  String get pullToRefresh => 'اسحب للتحديث';

  @override
  String get offlineData => 'غير متصل — يتم عرض آخر معلومات متاحة';

  @override
  String get noRecentActivity => 'لا يوجد نشاط حديث';

  @override
  String get recentActivity => 'النشاط الأخير';

  @override
  String get quickActions => 'إجراءات سريعة';

  @override
  String get ordersToday => 'طلبات اليوم';

  @override
  String get newStatus => 'جديد';

  @override
  String get assignedToDriver => 'تم التعيين للسائق';

  @override
  String get outForDelivery => 'خرج للتوصيل';

  @override
  String get delivered => 'تم التوصيل';

  @override
  String get returnedToBranch => 'أُعيد إلى الفرع';

  @override
  String get returnedToTrader => 'أُعيد إلى التاجر';

  @override
  String get cancelled => 'ملغى';

  @override
  String get unknownStatus => 'حالة غير معروفة';

  @override
  String get deliveredCod => 'الدفع عند الاستلام للطلبات المسلمة';

  @override
  String get serviceFees => 'رسوم الخدمة';

  @override
  String get netPayable => 'صافي المستحق';

  @override
  String get moneySent => 'الأموال المرسلة';

  @override
  String get outstandingAmount => 'المبلغ المستحق';

  @override
  String get assignedOrders => 'الطلبات المعيّنة';

  @override
  String get deliveredToday => 'تم توصيلها اليوم';

  @override
  String get unsuccessfulToday => 'غير ناجحة اليوم';

  @override
  String get returnRequired => 'مطلوب الإرجاع إلى الفرع';

  @override
  String get codCollectedToday => 'المبلغ المحصل اليوم';

  @override
  String get unreadMessages => 'رسائل غير مقروءة';

  @override
  String get unassignedOrders => 'طلبات غير معيّنة';

  @override
  String get deliveryFailures => 'حالات فشل التوصيل';

  @override
  String get itemsRequiringAttention => 'عناصر تتطلب الانتباه';

  @override
  String get trackCurrentOrder => 'تتبع الطلب الحالي';

  @override
  String get activeOrders => 'الطلبات النشطة';

  @override
  String get recentDeliveries => 'عمليات التوصيل الأخيرة';

  @override
  String get noDashboardData => 'بيانات لوحة المعلومات غير متاحة بعد.';

  @override
  String get notificationsUnavailable => 'صندوق الإشعارات غير متاح بعد.';

  @override
  String get noNotifications => 'لا توجد إشعارات';

  @override
  String get markAllRead => 'تحديد الكل كمقروء';

  @override
  String get search => 'بحث';

  @override
  String get filters => 'عوامل التصفية';

  @override
  String get apply => 'تطبيق';

  @override
  String get clear => 'مسح';

  @override
  String get reset => 'إعادة تعيين';

  @override
  String get orderNumber => 'رقم الطلب';

  @override
  String get externalReference => 'المرجع الخارجي';

  @override
  String get customerName => 'اسم العميل';

  @override
  String get emirate => 'الإمارة';

  @override
  String get area => 'المنطقة';

  @override
  String get cod => 'الدفع عند الاستلام';

  @override
  String get deliveryFee => 'رسوم التوصيل';

  @override
  String get currentStatus => 'الحالة الحالية';

  @override
  String get cachedData => 'بيانات مخزنة مؤقتاً';

  @override
  String get about => 'حول BluelineGPT';

  @override
  String get createNewOrder => 'إنشاء طلب جديد';

  @override
  String get customerMobile => 'رقم هاتف العميل المتحرك';

  @override
  String get address => 'العنوان';

  @override
  String get notes => 'ملاحظات';

  @override
  String get selectEmirate => 'اختر الإمارة';

  @override
  String get selectArea => 'اختر المنطقة';

  @override
  String get pricingUnavailable =>
      'لا يمكن معاينة سعر توصيل نشط لهذا الطلب. يرجى التواصل مع شركة التوصيل.';

  @override
  String get reviewOrder => 'مراجعة الطلب';

  @override
  String get submitOrder => 'إرسال الطلب';

  @override
  String get edit => 'تعديل';

  @override
  String get orderCreated => 'تم إنشاء الطلب بنجاح';

  @override
  String get viewOrder => 'عرض الطلب';

  @override
  String get createAnother => 'إنشاء طلب آخر';

  @override
  String get allActive => 'جميع النشطة';

  @override
  String get ordersLimited =>
      'يتم عرض أحدث الطلبات المتاحة. ترقيم صفحات الخادم غير متاح بعد.';

  @override
  String get noOrders => 'لا توجد طلبات متاحة';

  @override
  String get messageOffice => 'مراسلة المكتب';

  @override
  String get orderDetailsUnavailable =>
      'تفاصيل الطلب والتسلسل الزمني غير متاحين من واجهة التاجر الخلفية بعد.';

  @override
  String get cancellationUnavailable =>
      'إلغاء التاجر غير متاح من الواجهة الخلفية بعد.';

  @override
  String get financialSummary => 'الملخص المالي';

  @override
  String get settlements => 'التسويات';

  @override
  String get accountStatement => 'كشف الحساب';

  @override
  String get traderFinanceUnavailable =>
      'المعلومات المالية الخاصة بالتاجر غير متاحة بعد.';

  @override
  String get invalidReference =>
      'استخدم حتى 160 حرفاً أو رقماً أو مسافة أو شرطة أو شرطة سفلية أو شرطة مائلة.';

  @override
  String get pricingRequired => 'يلزم توفر معاينة سعر موثقة قبل إرسال الطلب.';

  @override
  String get more => 'المزيد';

  @override
  String get notImplemented => 'هذه الوحدة غير منفذة بعد.';

  @override
  String get accessDenied => 'غير مصرح بالدخول';

  @override
  String get notFound => 'الصفحة غير موجودة';

  @override
  String get offline => 'أنت غير متصل بالإنترنت';

  @override
  String get sessionExpired => 'انتهت صلاحية جلستك.';

  @override
  String get contactSupport => 'اتصل بالدعم';

  @override
  String get language => 'اللغة';

  @override
  String get requiredField => 'هذا الحقل مطلوب.';

  @override
  String get invalidNumber => 'أدخل رقماً صحيحاً.';

  @override
  String get invalidMobile =>
      'أدخل رقم هاتف متحرك إماراتي صحيحاً، مثل +971506468441.';

  @override
  String get startDelivery => 'بدء التوصيل';

  @override
  String get callCustomer => 'الاتصال بالعميل';

  @override
  String get openMap => 'فتح الخريطة';

  @override
  String get markDelivered => 'تأكيد التسليم';

  @override
  String get reportFailure => 'تسجيل تعذر التسليم';

  @override
  String get driverOrdersLimited =>
      'يتم عرض أحدث الطلبات المسندة المتاحة من الخادم. يتطلب البحث والتصفية وتقسيم الصفحات تحديثاً للخادم.';

  @override
  String get driverActionUnavailable =>
      'إجراء السائق هذا غير متاح حتى توفير عقد خلفي آمن ومطلوب.';

  @override
  String get startDeliveryConfirm => 'هل تريد بدء توصيل هذا الطلب؟';

  @override
  String get deliveryStarted => 'بدأ التوصيل.';

  @override
  String get expectedCod => 'الدفع عند الاستلام المتوقع';

  @override
  String get invalidCustomerContact => 'رقم هاتف العميل غير متاح أو غير صالح.';

  @override
  String get externalAppUnavailable => 'لا يتوفر تطبيق هاتف أو خرائط متوافق.';

  @override
  String get operatorOrders => 'الطلبات التشغيلية';

  @override
  String get operatorAccessRequired => 'ليس لديك إذن لعرض الطلبات التشغيلية.';

  @override
  String get assignDriver => 'إسناد سائق';

  @override
  String get reassignDriver => 'إعادة إسناد السائق';

  @override
  String get selectDriver => 'اختر سائقاً نشطاً';

  @override
  String get assignmentConfirm => 'هل تريد إسناد هذا السائق إلى الطلب؟';

  @override
  String get reassignmentConfirm =>
      'هل تريد إعادة إسناد هذا الطلب إلى سائق مختلف؟';

  @override
  String get assignmentCompleted => 'تم إسناد السائق.';

  @override
  String get reassignmentCompleted => 'تمت إعادة إسناد السائق.';

  @override
  String get operatorActionsUnavailable =>
      'تتطلب القرارات التشغيلية الإضافية عقوداً خلفية مخصصة.';

  @override
  String get orderActions => 'الإجراءات';

  @override
  String get changeStatusAction => 'تغيير الحالة';

  @override
  String get confirmStatusChange => 'هل تريد تغيير حالة هذا الطلب؟';

  @override
  String get statusUpdateCompleted => 'تم تحديث الحالة.';

  @override
  String get reasonLabel => 'السبب';

  @override
  String get reasonRequiredError => 'السبب مطلوب لهذا التغيير.';

  @override
  String get returnPending => 'بانتظار الإرجاع';

  @override
  String get totalActiveOrders => 'إجمالي الطلبات النشطة';

  @override
  String get orderHistory => 'سجل الطلب';

  @override
  String get assignedDriverLabel => 'السائق المسند';

  @override
  String get myActiveOrders => 'طلباتي النشطة';

  @override
  String get assignedToMe => 'مسندة لي';

  @override
  String get orderDate => 'تاريخ الطلب';

  @override
  String get serialNumber => 'الرقم التسلسلي';

  @override
  String get location => 'الموقع';

  @override
  String get reference => 'المرجع';

  @override
  String get emptyValuePlaceholder => '—';

  @override
  String get returnToBranchAction => 'إرجاع إلى الفرع';

  @override
  String get companyLabel => 'الشركة';

  @override
  String get traderLabel => 'التاجر';

  @override
  String get mobileLabel => 'الجوال';

  @override
  String get loadMore => 'تحميل المزيد';

  @override
  String get trackingLinkExpired =>
      'رابط التتبع غير صالح أو منتهي أو ملغى. يرجى طلب رابط جديد من شركة التوصيل.';

  @override
  String get customerAccessUnavailable =>
      'الدخول بحساب العميل غير متاح. استخدم رابط تتبع آمن مقدم من شركة التوصيل.';

  @override
  String get orderReceived => 'تم استلام الطلب';

  @override
  String get assignedForDelivery => 'تم الإسناد للتوصيل';

  @override
  String get deliveryIssue => 'مشكلة في التوصيل';

  @override
  String get statusUpdating => 'جارٍ تحديث الحالة';

  @override
  String get lastUpdatedLabel => 'آخر تحديث';

  @override
  String get deliveredAtLabel => 'وقت التسليم';

  @override
  String get officeSupportUnavailable => 'مراسلة دعم المكتب غير متاحة بعد.';

  @override
  String get customerPrivacyNotice =>
      'يتم عرض معلومات التتبع الآمنة للعميل فقط.';

  @override
  String get communicationInbox => 'مركز التواصل';

  @override
  String get communicationUnavailable =>
      'المراسلة الآمنة غير متاحة حتى توفير خدمة التواصل الخلفية المشتركة.';

  @override
  String get communicationSafetyNotice =>
      'لا تتم محاكاة الرسائل ولا اعتبارها مسلمة دون تأكيد الخادم.';

  @override
  String get noConversations => 'لا توجد محادثات بعد';

  @override
  String get noMessages => 'لا توجد رسائل بعد';

  @override
  String get messageInputHint => 'اكتب رسالة';

  @override
  String get sendMessage => 'إرسال';

  @override
  String get recordVoiceMessage => 'تسجيل رسالة صوتية';

  @override
  String get recordingInProgress => 'جارٍ التسجيل…';

  @override
  String get stopRecordingAction => 'إيقاف';

  @override
  String get discardRecordingAction => 'حذف';

  @override
  String get sendVoiceMessageAction => 'إرسال الرسالة الصوتية';

  @override
  String get voiceMessageLabel => 'رسالة صوتية';

  @override
  String get microphonePermissionRequired =>
      'يلزم الوصول إلى الميكروفون لتسجيل رسالة صوتية.';

  @override
  String get microphonePermissionDenied =>
      'تم رفض الوصول إلى الميكروفون. فعّله من إعدادات جهازك لتسجيل الرسائل الصوتية.';

  @override
  String get recordingFailed => 'فشل التسجيل. يرجى المحاولة مرة أخرى.';

  @override
  String get voiceSendFailed => 'تعذر إرسال الرسالة الصوتية.';

  @override
  String get unsupportedAudioFormat => 'تنسيق الصوت هذا غير مدعوم.';

  @override
  String get audioFileTooLarge => 'حجم التسجيل كبير جداً ولا يمكن إرساله.';

  @override
  String get maxRecordingDurationReachedNotice =>
      'تم بلوغ الحد الأقصى لمدة التسجيل (5 دقائق).';

  @override
  String get audioUnavailable => 'هذه الرسالة الصوتية غير متاحة.';

  @override
  String get playAction => 'تشغيل';

  @override
  String get pauseAction => 'إيقاف مؤقت';

  @override
  String get conversationsUnavailable => 'تعذر تحميل المحادثات.';

  @override
  String get messageSendFailed => 'تعذر إرسال الرسالة.';

  @override
  String get enableNotifications => 'تفعيل الإشعارات';

  @override
  String get notificationPermissionRequired =>
      'فعّل الإشعارات لتصلك تنبيهات فورية بالرسائل الجديدة وتحديثات الطلبات.';

  @override
  String get notificationPermissionDenied =>
      'الإشعارات متوقفة. يمكنك دائماً مراجعة هذه الشاشة للاطلاع على التحديثات.';

  @override
  String get openNotificationSettings => 'فتح الإعدادات';

  @override
  String get newMessageNotification => 'رسالة جديدة';

  @override
  String get voiceMessageNotification => 'رسالة صوتية جديدة';

  @override
  String get orderUpdatedNotification => 'تم تحديث الطلب';

  @override
  String get orderAssignedNotification => 'تم إسناد الطلب';

  @override
  String get orderReassignedNotification => 'تمت إعادة إسناد الطلب';

  @override
  String get driverOfflineBanner => 'غير متصل';

  @override
  String get driverLastSyncedLabel => 'آخر مزامنة';

  @override
  String get driverSyncPending => 'بانتظار المزامنة';

  @override
  String get driverSyncInProgress => 'جارٍ المزامنة…';

  @override
  String get driverSyncCompleted => 'تمت المزامنة';

  @override
  String get driverSyncFailed => 'فشلت المزامنة';

  @override
  String get driverSyncNeedsReview => 'يتطلب المراجعة';

  @override
  String get driverConflictMessage =>
      'تغيّر هذا الطلب أثناء عدم اتصالك. يرجى تحديث الطلب قبل المتابعة.';

  @override
  String get driverRefreshAction => 'تحديث';

  @override
  String get holdStatus => 'معلّق';

  @override
  String get hold => 'تعليق';

  @override
  String get orderPlacedOnHold => 'تم تعليق الطلب.';

  @override
  String get companyCode => 'رمز الشركة';

  @override
  String get companyCodeHelp =>
      'أدخل الرمز المكوّن من 6 أرقام من ورقة QR الخاصة بشركتك أو من التقرير المطبوع، أو اطلبه من المسؤول.';

  @override
  String get companyCodeInvalid => 'أدخل رمز الشركة المكوّن من 6 أرقام.';

  @override
  String get companyCodeContinue => 'متابعة';

  @override
  String get changeCompany => 'تغيير الشركة';
}
