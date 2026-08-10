import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_ar.dart';
import 'app_localizations_en.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'localization/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale)
    : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations)!;
  }

  static const LocalizationsDelegate<AppLocalizations> delegate =
      _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('ar'),
    Locale('en'),
  ];

  /// No description provided for @appName.
  ///
  /// In en, this message translates to:
  /// **'BluelineGPT'**
  String get appName;

  /// No description provided for @startup.
  ///
  /// In en, this message translates to:
  /// **'Starting BluelineGPT…'**
  String get startup;

  /// No description provided for @retry.
  ///
  /// In en, this message translates to:
  /// **'Retry'**
  String get retry;

  /// No description provided for @somethingWentWrong.
  ///
  /// In en, this message translates to:
  /// **'Something went wrong'**
  String get somethingWentWrong;

  /// No description provided for @serviceUnavailable.
  ///
  /// In en, this message translates to:
  /// **'The service is currently unavailable.'**
  String get serviceUnavailable;

  /// No description provided for @login.
  ///
  /// In en, this message translates to:
  /// **'Log in'**
  String get login;

  /// No description provided for @identifier.
  ///
  /// In en, this message translates to:
  /// **'Username, email, or mobile number'**
  String get identifier;

  /// No description provided for @password.
  ///
  /// In en, this message translates to:
  /// **'Password'**
  String get password;

  /// No description provided for @showPassword.
  ///
  /// In en, this message translates to:
  /// **'Show password'**
  String get showPassword;

  /// No description provided for @hidePassword.
  ///
  /// In en, this message translates to:
  /// **'Hide password'**
  String get hidePassword;

  /// No description provided for @invalidCredentials.
  ///
  /// In en, this message translates to:
  /// **'The login identifier or password is invalid.'**
  String get invalidCredentials;

  /// No description provided for @loginUnavailable.
  ///
  /// In en, this message translates to:
  /// **'Unable to sign in right now. Please try again.'**
  String get loginUnavailable;

  /// No description provided for @unsupportedRole.
  ///
  /// In en, this message translates to:
  /// **'Your account is active, but this role is not yet supported in the mobile application.'**
  String get unsupportedRole;

  /// No description provided for @missingCompany.
  ///
  /// In en, this message translates to:
  /// **'Your Company access could not be verified.'**
  String get missingCompany;

  /// No description provided for @missingProfile.
  ///
  /// In en, this message translates to:
  /// **'Your linked business profile could not be verified.'**
  String get missingProfile;

  /// No description provided for @accountUnavailable.
  ///
  /// In en, this message translates to:
  /// **'This account cannot access the mobile application.'**
  String get accountUnavailable;

  /// No description provided for @forgotPasswordUnavailable.
  ///
  /// In en, this message translates to:
  /// **'Password recovery is not available yet. Please contact your Company administrator or support.'**
  String get forgotPasswordUnavailable;

  /// No description provided for @forgotPassword.
  ///
  /// In en, this message translates to:
  /// **'Forgot password'**
  String get forgotPassword;

  /// No description provided for @dashboard.
  ///
  /// In en, this message translates to:
  /// **'Dashboard'**
  String get dashboard;

  /// No description provided for @orders.
  ///
  /// In en, this message translates to:
  /// **'Orders'**
  String get orders;

  /// No description provided for @orderDetails.
  ///
  /// In en, this message translates to:
  /// **'Order Details'**
  String get orderDetails;

  /// No description provided for @createOrder.
  ///
  /// In en, this message translates to:
  /// **'Create order'**
  String get createOrder;

  /// No description provided for @myOrders.
  ///
  /// In en, this message translates to:
  /// **'My orders'**
  String get myOrders;

  /// No description provided for @trackOrder.
  ///
  /// In en, this message translates to:
  /// **'Track Order'**
  String get trackOrder;

  /// No description provided for @messages.
  ///
  /// In en, this message translates to:
  /// **'Messages'**
  String get messages;

  /// No description provided for @notifications.
  ///
  /// In en, this message translates to:
  /// **'Notifications'**
  String get notifications;

  /// No description provided for @profile.
  ///
  /// In en, this message translates to:
  /// **'Profile'**
  String get profile;

  /// No description provided for @settings.
  ///
  /// In en, this message translates to:
  /// **'Settings'**
  String get settings;

  /// No description provided for @account.
  ///
  /// In en, this message translates to:
  /// **'Account'**
  String get account;

  /// No description provided for @signedInAs.
  ///
  /// In en, this message translates to:
  /// **'Signed in as'**
  String get signedInAs;

  /// No description provided for @role.
  ///
  /// In en, this message translates to:
  /// **'Role'**
  String get role;

  /// No description provided for @trader.
  ///
  /// In en, this message translates to:
  /// **'Trader'**
  String get trader;

  /// No description provided for @driver.
  ///
  /// In en, this message translates to:
  /// **'Driver'**
  String get driver;

  /// No description provided for @operator.
  ///
  /// In en, this message translates to:
  /// **'Operator'**
  String get operator;

  /// No description provided for @customer.
  ///
  /// In en, this message translates to:
  /// **'Customer'**
  String get customer;

  /// No description provided for @appVersion.
  ///
  /// In en, this message translates to:
  /// **'Application version'**
  String get appVersion;

  /// No description provided for @helpSupport.
  ///
  /// In en, this message translates to:
  /// **'Help and support'**
  String get helpSupport;

  /// No description provided for @privacyPolicy.
  ///
  /// In en, this message translates to:
  /// **'Privacy policy'**
  String get privacyPolicy;

  /// No description provided for @termsConditions.
  ///
  /// In en, this message translates to:
  /// **'Terms and conditions'**
  String get termsConditions;

  /// No description provided for @changePassword.
  ///
  /// In en, this message translates to:
  /// **'Change password'**
  String get changePassword;

  /// No description provided for @currentPassword.
  ///
  /// In en, this message translates to:
  /// **'Current password'**
  String get currentPassword;

  /// No description provided for @newPassword.
  ///
  /// In en, this message translates to:
  /// **'New password'**
  String get newPassword;

  /// No description provided for @savePassword.
  ///
  /// In en, this message translates to:
  /// **'Save password'**
  String get savePassword;

  /// No description provided for @passwordMinimum.
  ///
  /// In en, this message translates to:
  /// **'Use at least 8 characters.'**
  String get passwordMinimum;

  /// No description provided for @passwordChanged.
  ///
  /// In en, this message translates to:
  /// **'Password changed successfully.'**
  String get passwordChanged;

  /// No description provided for @passwordChangeFailed.
  ///
  /// In en, this message translates to:
  /// **'The password could not be changed.'**
  String get passwordChangeFailed;

  /// No description provided for @logout.
  ///
  /// In en, this message translates to:
  /// **'Log out'**
  String get logout;

  /// No description provided for @logoutConfirm.
  ///
  /// In en, this message translates to:
  /// **'Log out of BluelineGPT?'**
  String get logoutConfirm;

  /// No description provided for @cancel.
  ///
  /// In en, this message translates to:
  /// **'Cancel'**
  String get cancel;

  /// No description provided for @welcome.
  ///
  /// In en, this message translates to:
  /// **'Welcome'**
  String get welcome;

  /// No description provided for @lastUpdated.
  ///
  /// In en, this message translates to:
  /// **'Last updated'**
  String get lastUpdated;

  /// No description provided for @notAvailable.
  ///
  /// In en, this message translates to:
  /// **'Not available'**
  String get notAvailable;

  /// No description provided for @dataUnavailable.
  ///
  /// In en, this message translates to:
  /// **'Data is currently unavailable.'**
  String get dataUnavailable;

  /// No description provided for @pullToRefresh.
  ///
  /// In en, this message translates to:
  /// **'Pull to refresh'**
  String get pullToRefresh;

  /// No description provided for @offlineData.
  ///
  /// In en, this message translates to:
  /// **'Offline — showing the latest available information'**
  String get offlineData;

  /// No description provided for @noRecentActivity.
  ///
  /// In en, this message translates to:
  /// **'No recent activity'**
  String get noRecentActivity;

  /// No description provided for @recentActivity.
  ///
  /// In en, this message translates to:
  /// **'Recent activity'**
  String get recentActivity;

  /// No description provided for @quickActions.
  ///
  /// In en, this message translates to:
  /// **'Quick actions'**
  String get quickActions;

  /// No description provided for @ordersToday.
  ///
  /// In en, this message translates to:
  /// **'Orders today'**
  String get ordersToday;

  /// No description provided for @newStatus.
  ///
  /// In en, this message translates to:
  /// **'New'**
  String get newStatus;

  /// No description provided for @assignedToDriver.
  ///
  /// In en, this message translates to:
  /// **'Assigned to Driver'**
  String get assignedToDriver;

  /// No description provided for @outForDelivery.
  ///
  /// In en, this message translates to:
  /// **'Out for Delivery'**
  String get outForDelivery;

  /// No description provided for @delivered.
  ///
  /// In en, this message translates to:
  /// **'Delivered'**
  String get delivered;

  /// No description provided for @returnedToBranch.
  ///
  /// In en, this message translates to:
  /// **'Returned to Branch'**
  String get returnedToBranch;

  /// No description provided for @returnedToTrader.
  ///
  /// In en, this message translates to:
  /// **'Returned to Trader'**
  String get returnedToTrader;

  /// No description provided for @cancelled.
  ///
  /// In en, this message translates to:
  /// **'Cancelled'**
  String get cancelled;

  /// No description provided for @unknownStatus.
  ///
  /// In en, this message translates to:
  /// **'Unknown status'**
  String get unknownStatus;

  /// No description provided for @deliveredCod.
  ///
  /// In en, this message translates to:
  /// **'Delivered COD'**
  String get deliveredCod;

  /// No description provided for @serviceFees.
  ///
  /// In en, this message translates to:
  /// **'Service fees'**
  String get serviceFees;

  /// No description provided for @netPayable.
  ///
  /// In en, this message translates to:
  /// **'Net payable'**
  String get netPayable;

  /// No description provided for @moneySent.
  ///
  /// In en, this message translates to:
  /// **'Money sent'**
  String get moneySent;

  /// No description provided for @outstandingAmount.
  ///
  /// In en, this message translates to:
  /// **'Outstanding amount'**
  String get outstandingAmount;

  /// No description provided for @assignedOrders.
  ///
  /// In en, this message translates to:
  /// **'Assigned orders'**
  String get assignedOrders;

  /// No description provided for @deliveredToday.
  ///
  /// In en, this message translates to:
  /// **'Delivered today'**
  String get deliveredToday;

  /// No description provided for @unsuccessfulToday.
  ///
  /// In en, this message translates to:
  /// **'Unsuccessful today'**
  String get unsuccessfulToday;

  /// No description provided for @returnRequired.
  ///
  /// In en, this message translates to:
  /// **'Return to Branch required'**
  String get returnRequired;

  /// No description provided for @codCollectedToday.
  ///
  /// In en, this message translates to:
  /// **'COD collected today'**
  String get codCollectedToday;

  /// No description provided for @unreadMessages.
  ///
  /// In en, this message translates to:
  /// **'Unread messages'**
  String get unreadMessages;

  /// No description provided for @unassignedOrders.
  ///
  /// In en, this message translates to:
  /// **'Unassigned orders'**
  String get unassignedOrders;

  /// No description provided for @deliveryFailures.
  ///
  /// In en, this message translates to:
  /// **'Delivery failures'**
  String get deliveryFailures;

  /// No description provided for @itemsRequiringAttention.
  ///
  /// In en, this message translates to:
  /// **'Items requiring attention'**
  String get itemsRequiringAttention;

  /// No description provided for @trackCurrentOrder.
  ///
  /// In en, this message translates to:
  /// **'Track current Order'**
  String get trackCurrentOrder;

  /// No description provided for @activeOrders.
  ///
  /// In en, this message translates to:
  /// **'Active Orders'**
  String get activeOrders;

  /// No description provided for @recentDeliveries.
  ///
  /// In en, this message translates to:
  /// **'Recent deliveries'**
  String get recentDeliveries;

  /// No description provided for @noDashboardData.
  ///
  /// In en, this message translates to:
  /// **'Dashboard data is not available yet.'**
  String get noDashboardData;

  /// No description provided for @notificationsUnavailable.
  ///
  /// In en, this message translates to:
  /// **'The notification inbox is not available yet.'**
  String get notificationsUnavailable;

  /// No description provided for @noNotifications.
  ///
  /// In en, this message translates to:
  /// **'No notifications'**
  String get noNotifications;

  /// No description provided for @markAllRead.
  ///
  /// In en, this message translates to:
  /// **'Mark all as read'**
  String get markAllRead;

  /// No description provided for @search.
  ///
  /// In en, this message translates to:
  /// **'Search'**
  String get search;

  /// No description provided for @filters.
  ///
  /// In en, this message translates to:
  /// **'Filters'**
  String get filters;

  /// No description provided for @apply.
  ///
  /// In en, this message translates to:
  /// **'Apply'**
  String get apply;

  /// No description provided for @clear.
  ///
  /// In en, this message translates to:
  /// **'Clear'**
  String get clear;

  /// No description provided for @reset.
  ///
  /// In en, this message translates to:
  /// **'Reset'**
  String get reset;

  /// No description provided for @orderNumber.
  ///
  /// In en, this message translates to:
  /// **'Order number'**
  String get orderNumber;

  /// No description provided for @externalReference.
  ///
  /// In en, this message translates to:
  /// **'External reference'**
  String get externalReference;

  /// No description provided for @customerName.
  ///
  /// In en, this message translates to:
  /// **'Customer name'**
  String get customerName;

  /// No description provided for @emirate.
  ///
  /// In en, this message translates to:
  /// **'Emirate'**
  String get emirate;

  /// No description provided for @area.
  ///
  /// In en, this message translates to:
  /// **'Area'**
  String get area;

  /// No description provided for @cod.
  ///
  /// In en, this message translates to:
  /// **'COD'**
  String get cod;

  /// No description provided for @deliveryFee.
  ///
  /// In en, this message translates to:
  /// **'Delivery fee'**
  String get deliveryFee;

  /// No description provided for @currentStatus.
  ///
  /// In en, this message translates to:
  /// **'Current status'**
  String get currentStatus;

  /// No description provided for @cachedData.
  ///
  /// In en, this message translates to:
  /// **'Cached data'**
  String get cachedData;

  /// No description provided for @about.
  ///
  /// In en, this message translates to:
  /// **'About BluelineGPT'**
  String get about;

  /// No description provided for @createNewOrder.
  ///
  /// In en, this message translates to:
  /// **'Create New Order'**
  String get createNewOrder;

  /// No description provided for @customerMobile.
  ///
  /// In en, this message translates to:
  /// **'Customer mobile number'**
  String get customerMobile;

  /// No description provided for @address.
  ///
  /// In en, this message translates to:
  /// **'Address'**
  String get address;

  /// No description provided for @notes.
  ///
  /// In en, this message translates to:
  /// **'Notes'**
  String get notes;

  /// No description provided for @selectEmirate.
  ///
  /// In en, this message translates to:
  /// **'Select Emirate'**
  String get selectEmirate;

  /// No description provided for @selectArea.
  ///
  /// In en, this message translates to:
  /// **'Select Area'**
  String get selectArea;

  /// No description provided for @pricingUnavailable.
  ///
  /// In en, this message translates to:
  /// **'No active delivery price can be previewed for this Order. Please contact the delivery company.'**
  String get pricingUnavailable;

  /// No description provided for @reviewOrder.
  ///
  /// In en, this message translates to:
  /// **'Review Order'**
  String get reviewOrder;

  /// No description provided for @submitOrder.
  ///
  /// In en, this message translates to:
  /// **'Submit Order'**
  String get submitOrder;

  /// No description provided for @edit.
  ///
  /// In en, this message translates to:
  /// **'Edit'**
  String get edit;

  /// No description provided for @orderCreated.
  ///
  /// In en, this message translates to:
  /// **'Order created successfully'**
  String get orderCreated;

  /// No description provided for @viewOrder.
  ///
  /// In en, this message translates to:
  /// **'View Order'**
  String get viewOrder;

  /// No description provided for @createAnother.
  ///
  /// In en, this message translates to:
  /// **'Create another Order'**
  String get createAnother;

  /// No description provided for @allActive.
  ///
  /// In en, this message translates to:
  /// **'All Active'**
  String get allActive;

  /// No description provided for @ordersLimited.
  ///
  /// In en, this message translates to:
  /// **'Showing the latest available Orders. Server pagination is not available yet.'**
  String get ordersLimited;

  /// No description provided for @noOrders.
  ///
  /// In en, this message translates to:
  /// **'No Orders available'**
  String get noOrders;

  /// No description provided for @messageOffice.
  ///
  /// In en, this message translates to:
  /// **'Message Office'**
  String get messageOffice;

  /// No description provided for @orderDetailsUnavailable.
  ///
  /// In en, this message translates to:
  /// **'Order details and timeline are not available from the Trader backend yet.'**
  String get orderDetailsUnavailable;

  /// No description provided for @cancellationUnavailable.
  ///
  /// In en, this message translates to:
  /// **'Trader cancellation is not available from the backend yet.'**
  String get cancellationUnavailable;

  /// No description provided for @financialSummary.
  ///
  /// In en, this message translates to:
  /// **'Financial summary'**
  String get financialSummary;

  /// No description provided for @settlements.
  ///
  /// In en, this message translates to:
  /// **'Settlements'**
  String get settlements;

  /// No description provided for @accountStatement.
  ///
  /// In en, this message translates to:
  /// **'Account Statement'**
  String get accountStatement;

  /// No description provided for @traderFinanceUnavailable.
  ///
  /// In en, this message translates to:
  /// **'Trader-scoped financial information is not available yet.'**
  String get traderFinanceUnavailable;

  /// No description provided for @invalidReference.
  ///
  /// In en, this message translates to:
  /// **'Use up to 160 letters, numbers, spaces, hyphens, underscores, or slashes.'**
  String get invalidReference;

  /// No description provided for @pricingRequired.
  ///
  /// In en, this message translates to:
  /// **'A verified pricing preview is required before submission.'**
  String get pricingRequired;

  /// No description provided for @more.
  ///
  /// In en, this message translates to:
  /// **'More'**
  String get more;

  /// No description provided for @notImplemented.
  ///
  /// In en, this message translates to:
  /// **'This module is not implemented yet.'**
  String get notImplemented;

  /// No description provided for @accessDenied.
  ///
  /// In en, this message translates to:
  /// **'Access denied'**
  String get accessDenied;

  /// No description provided for @notFound.
  ///
  /// In en, this message translates to:
  /// **'Page not found'**
  String get notFound;

  /// No description provided for @offline.
  ///
  /// In en, this message translates to:
  /// **'You are offline'**
  String get offline;

  /// No description provided for @sessionExpired.
  ///
  /// In en, this message translates to:
  /// **'Your session has expired.'**
  String get sessionExpired;

  /// No description provided for @contactSupport.
  ///
  /// In en, this message translates to:
  /// **'Contact support'**
  String get contactSupport;

  /// No description provided for @language.
  ///
  /// In en, this message translates to:
  /// **'Language'**
  String get language;

  /// No description provided for @requiredField.
  ///
  /// In en, this message translates to:
  /// **'This field is required.'**
  String get requiredField;

  /// No description provided for @invalidNumber.
  ///
  /// In en, this message translates to:
  /// **'Enter a valid number.'**
  String get invalidNumber;

  /// No description provided for @invalidMobile.
  ///
  /// In en, this message translates to:
  /// **'Enter a valid UAE mobile number, for example +971506468441.'**
  String get invalidMobile;

  /// No description provided for @startDelivery.
  ///
  /// In en, this message translates to:
  /// **'Start Delivery'**
  String get startDelivery;

  /// No description provided for @callCustomer.
  ///
  /// In en, this message translates to:
  /// **'Call Customer'**
  String get callCustomer;

  /// No description provided for @openMap.
  ///
  /// In en, this message translates to:
  /// **'Open Map'**
  String get openMap;

  /// No description provided for @markDelivered.
  ///
  /// In en, this message translates to:
  /// **'Mark Delivered'**
  String get markDelivered;

  /// No description provided for @reportFailure.
  ///
  /// In en, this message translates to:
  /// **'Report Unsuccessful Delivery'**
  String get reportFailure;

  /// No description provided for @driverOrdersLimited.
  ///
  /// In en, this message translates to:
  /// **'Showing the latest assigned Orders available from the server. Search, filters, and pagination require a backend update.'**
  String get driverOrdersLimited;

  /// No description provided for @driverActionUnavailable.
  ///
  /// In en, this message translates to:
  /// **'This Driver action is not available until the required secure backend contract is provided.'**
  String get driverActionUnavailable;

  /// No description provided for @startDeliveryConfirm.
  ///
  /// In en, this message translates to:
  /// **'Start delivery for this Order?'**
  String get startDeliveryConfirm;

  /// No description provided for @deliveryStarted.
  ///
  /// In en, this message translates to:
  /// **'Delivery started.'**
  String get deliveryStarted;

  /// No description provided for @expectedCod.
  ///
  /// In en, this message translates to:
  /// **'Expected COD'**
  String get expectedCod;

  /// No description provided for @invalidCustomerContact.
  ///
  /// In en, this message translates to:
  /// **'The Customer mobile number is unavailable or invalid.'**
  String get invalidCustomerContact;

  /// No description provided for @externalAppUnavailable.
  ///
  /// In en, this message translates to:
  /// **'No compatible phone or map application is available.'**
  String get externalAppUnavailable;

  /// No description provided for @operatorOrders.
  ///
  /// In en, this message translates to:
  /// **'Operational Orders'**
  String get operatorOrders;

  /// No description provided for @operatorAccessRequired.
  ///
  /// In en, this message translates to:
  /// **'You do not have permission to view operational Orders.'**
  String get operatorAccessRequired;

  /// No description provided for @assignDriver.
  ///
  /// In en, this message translates to:
  /// **'Assign Driver'**
  String get assignDriver;

  /// No description provided for @reassignDriver.
  ///
  /// In en, this message translates to:
  /// **'Reassign Driver'**
  String get reassignDriver;

  /// No description provided for @selectDriver.
  ///
  /// In en, this message translates to:
  /// **'Select an active Driver'**
  String get selectDriver;

  /// No description provided for @assignmentConfirm.
  ///
  /// In en, this message translates to:
  /// **'Assign this Driver to the Order?'**
  String get assignmentConfirm;

  /// No description provided for @reassignmentConfirm.
  ///
  /// In en, this message translates to:
  /// **'Reassign this Order to a different Driver?'**
  String get reassignmentConfirm;

  /// No description provided for @assignmentCompleted.
  ///
  /// In en, this message translates to:
  /// **'Driver assigned.'**
  String get assignmentCompleted;

  /// No description provided for @reassignmentCompleted.
  ///
  /// In en, this message translates to:
  /// **'Driver reassigned.'**
  String get reassignmentCompleted;

  /// No description provided for @operatorActionsUnavailable.
  ///
  /// In en, this message translates to:
  /// **'Additional operational decisions require dedicated backend contracts.'**
  String get operatorActionsUnavailable;

  /// No description provided for @orderActions.
  ///
  /// In en, this message translates to:
  /// **'Actions'**
  String get orderActions;

  /// No description provided for @changeStatusAction.
  ///
  /// In en, this message translates to:
  /// **'Change Status'**
  String get changeStatusAction;

  /// No description provided for @confirmStatusChange.
  ///
  /// In en, this message translates to:
  /// **'Change this Order\'s status?'**
  String get confirmStatusChange;

  /// No description provided for @statusUpdateCompleted.
  ///
  /// In en, this message translates to:
  /// **'Status updated.'**
  String get statusUpdateCompleted;

  /// No description provided for @reasonLabel.
  ///
  /// In en, this message translates to:
  /// **'Reason'**
  String get reasonLabel;

  /// No description provided for @reasonRequiredError.
  ///
  /// In en, this message translates to:
  /// **'A reason is required for this change.'**
  String get reasonRequiredError;

  /// No description provided for @returnPending.
  ///
  /// In en, this message translates to:
  /// **'Return Pending'**
  String get returnPending;

  /// No description provided for @totalActiveOrders.
  ///
  /// In en, this message translates to:
  /// **'Total Active Orders'**
  String get totalActiveOrders;

  /// No description provided for @orderHistory.
  ///
  /// In en, this message translates to:
  /// **'Order History'**
  String get orderHistory;

  /// No description provided for @assignedDriverLabel.
  ///
  /// In en, this message translates to:
  /// **'Assigned Driver'**
  String get assignedDriverLabel;

  /// No description provided for @myActiveOrders.
  ///
  /// In en, this message translates to:
  /// **'My Active Orders'**
  String get myActiveOrders;

  /// No description provided for @assignedToMe.
  ///
  /// In en, this message translates to:
  /// **'Assigned to Me'**
  String get assignedToMe;

  /// No description provided for @orderDate.
  ///
  /// In en, this message translates to:
  /// **'Order Date'**
  String get orderDate;

  /// No description provided for @serialNumber.
  ///
  /// In en, this message translates to:
  /// **'Serial No.'**
  String get serialNumber;

  /// No description provided for @location.
  ///
  /// In en, this message translates to:
  /// **'Location'**
  String get location;

  /// No description provided for @reference.
  ///
  /// In en, this message translates to:
  /// **'Reference'**
  String get reference;

  /// No description provided for @emptyValuePlaceholder.
  ///
  /// In en, this message translates to:
  /// **'—'**
  String get emptyValuePlaceholder;

  /// No description provided for @returnToBranchAction.
  ///
  /// In en, this message translates to:
  /// **'Return to Branch'**
  String get returnToBranchAction;

  /// No description provided for @traderLabel.
  ///
  /// In en, this message translates to:
  /// **'Trader'**
  String get traderLabel;

  /// No description provided for @mobileLabel.
  ///
  /// In en, this message translates to:
  /// **'Mobile'**
  String get mobileLabel;

  /// No description provided for @loadMore.
  ///
  /// In en, this message translates to:
  /// **'Load more'**
  String get loadMore;

  /// No description provided for @trackingLinkExpired.
  ///
  /// In en, this message translates to:
  /// **'This tracking link is invalid, expired, or revoked. Please request a new link from the delivery company.'**
  String get trackingLinkExpired;

  /// No description provided for @customerAccessUnavailable.
  ///
  /// In en, this message translates to:
  /// **'Customer account access is not available. Use a secure tracking link supplied by the delivery company.'**
  String get customerAccessUnavailable;

  /// No description provided for @orderReceived.
  ///
  /// In en, this message translates to:
  /// **'Order Received'**
  String get orderReceived;

  /// No description provided for @assignedForDelivery.
  ///
  /// In en, this message translates to:
  /// **'Assigned for Delivery'**
  String get assignedForDelivery;

  /// No description provided for @deliveryIssue.
  ///
  /// In en, this message translates to:
  /// **'Delivery Issue'**
  String get deliveryIssue;

  /// No description provided for @statusUpdating.
  ///
  /// In en, this message translates to:
  /// **'Status Updating'**
  String get statusUpdating;

  /// No description provided for @lastUpdatedLabel.
  ///
  /// In en, this message translates to:
  /// **'Last updated'**
  String get lastUpdatedLabel;

  /// No description provided for @deliveredAtLabel.
  ///
  /// In en, this message translates to:
  /// **'Delivered at'**
  String get deliveredAtLabel;

  /// No description provided for @officeSupportUnavailable.
  ///
  /// In en, this message translates to:
  /// **'Office support messaging is not available yet.'**
  String get officeSupportUnavailable;

  /// No description provided for @customerPrivacyNotice.
  ///
  /// In en, this message translates to:
  /// **'Only Customer-safe tracking information is shown.'**
  String get customerPrivacyNotice;

  /// No description provided for @communicationInbox.
  ///
  /// In en, this message translates to:
  /// **'Communication Center'**
  String get communicationInbox;

  /// No description provided for @communicationUnavailable.
  ///
  /// In en, this message translates to:
  /// **'Secure messaging is unavailable until the shared backend communication service is provided.'**
  String get communicationUnavailable;

  /// No description provided for @communicationSafetyNotice.
  ///
  /// In en, this message translates to:
  /// **'Messages are never simulated or stored as delivered without server confirmation.'**
  String get communicationSafetyNotice;

  /// No description provided for @noConversations.
  ///
  /// In en, this message translates to:
  /// **'No conversations yet'**
  String get noConversations;

  /// No description provided for @noMessages.
  ///
  /// In en, this message translates to:
  /// **'No messages yet'**
  String get noMessages;

  /// No description provided for @messageInputHint.
  ///
  /// In en, this message translates to:
  /// **'Type a message'**
  String get messageInputHint;

  /// No description provided for @sendMessage.
  ///
  /// In en, this message translates to:
  /// **'Send'**
  String get sendMessage;

  /// No description provided for @recordVoiceMessage.
  ///
  /// In en, this message translates to:
  /// **'Record voice message'**
  String get recordVoiceMessage;

  /// No description provided for @recordingInProgress.
  ///
  /// In en, this message translates to:
  /// **'Recording…'**
  String get recordingInProgress;

  /// No description provided for @stopRecordingAction.
  ///
  /// In en, this message translates to:
  /// **'Stop'**
  String get stopRecordingAction;

  /// No description provided for @discardRecordingAction.
  ///
  /// In en, this message translates to:
  /// **'Discard'**
  String get discardRecordingAction;

  /// No description provided for @sendVoiceMessageAction.
  ///
  /// In en, this message translates to:
  /// **'Send voice message'**
  String get sendVoiceMessageAction;

  /// No description provided for @voiceMessageLabel.
  ///
  /// In en, this message translates to:
  /// **'Voice message'**
  String get voiceMessageLabel;

  /// No description provided for @microphonePermissionRequired.
  ///
  /// In en, this message translates to:
  /// **'Microphone access is required to record a voice message.'**
  String get microphonePermissionRequired;

  /// No description provided for @microphonePermissionDenied.
  ///
  /// In en, this message translates to:
  /// **'Microphone access was denied. Enable it in your device settings to record voice messages.'**
  String get microphonePermissionDenied;

  /// No description provided for @recordingFailed.
  ///
  /// In en, this message translates to:
  /// **'Recording failed. Please try again.'**
  String get recordingFailed;

  /// No description provided for @voiceSendFailed.
  ///
  /// In en, this message translates to:
  /// **'The voice message could not be sent.'**
  String get voiceSendFailed;

  /// No description provided for @unsupportedAudioFormat.
  ///
  /// In en, this message translates to:
  /// **'This audio format is not supported.'**
  String get unsupportedAudioFormat;

  /// No description provided for @audioFileTooLarge.
  ///
  /// In en, this message translates to:
  /// **'The recording is too large to send.'**
  String get audioFileTooLarge;

  /// No description provided for @maxRecordingDurationReachedNotice.
  ///
  /// In en, this message translates to:
  /// **'Maximum recording duration reached (5 minutes).'**
  String get maxRecordingDurationReachedNotice;

  /// No description provided for @audioUnavailable.
  ///
  /// In en, this message translates to:
  /// **'This voice message is unavailable.'**
  String get audioUnavailable;

  /// No description provided for @playAction.
  ///
  /// In en, this message translates to:
  /// **'Play'**
  String get playAction;

  /// No description provided for @pauseAction.
  ///
  /// In en, this message translates to:
  /// **'Pause'**
  String get pauseAction;

  /// No description provided for @conversationsUnavailable.
  ///
  /// In en, this message translates to:
  /// **'Conversations could not be loaded.'**
  String get conversationsUnavailable;

  /// No description provided for @messageSendFailed.
  ///
  /// In en, this message translates to:
  /// **'The message could not be sent.'**
  String get messageSendFailed;

  /// No description provided for @enableNotifications.
  ///
  /// In en, this message translates to:
  /// **'Enable notifications'**
  String get enableNotifications;

  /// No description provided for @notificationPermissionRequired.
  ///
  /// In en, this message translates to:
  /// **'Turn on notifications to be alerted about new messages and Order updates as they happen.'**
  String get notificationPermissionRequired;

  /// No description provided for @notificationPermissionDenied.
  ///
  /// In en, this message translates to:
  /// **'Notifications are off. You can still check this screen for updates.'**
  String get notificationPermissionDenied;

  /// No description provided for @openNotificationSettings.
  ///
  /// In en, this message translates to:
  /// **'Open Settings'**
  String get openNotificationSettings;

  /// No description provided for @newMessageNotification.
  ///
  /// In en, this message translates to:
  /// **'New message'**
  String get newMessageNotification;

  /// No description provided for @voiceMessageNotification.
  ///
  /// In en, this message translates to:
  /// **'New voice message'**
  String get voiceMessageNotification;

  /// No description provided for @orderUpdatedNotification.
  ///
  /// In en, this message translates to:
  /// **'Order updated'**
  String get orderUpdatedNotification;

  /// No description provided for @orderAssignedNotification.
  ///
  /// In en, this message translates to:
  /// **'Order assigned'**
  String get orderAssignedNotification;

  /// No description provided for @orderReassignedNotification.
  ///
  /// In en, this message translates to:
  /// **'Order reassigned'**
  String get orderReassignedNotification;

  /// No description provided for @driverOfflineBanner.
  ///
  /// In en, this message translates to:
  /// **'Offline'**
  String get driverOfflineBanner;

  /// No description provided for @driverLastSyncedLabel.
  ///
  /// In en, this message translates to:
  /// **'Last synced'**
  String get driverLastSyncedLabel;

  /// No description provided for @driverSyncPending.
  ///
  /// In en, this message translates to:
  /// **'Pending Sync'**
  String get driverSyncPending;

  /// No description provided for @driverSyncInProgress.
  ///
  /// In en, this message translates to:
  /// **'Syncing…'**
  String get driverSyncInProgress;

  /// No description provided for @driverSyncCompleted.
  ///
  /// In en, this message translates to:
  /// **'Synced'**
  String get driverSyncCompleted;

  /// No description provided for @driverSyncFailed.
  ///
  /// In en, this message translates to:
  /// **'Sync Failed'**
  String get driverSyncFailed;

  /// No description provided for @driverSyncNeedsReview.
  ///
  /// In en, this message translates to:
  /// **'Needs Review'**
  String get driverSyncNeedsReview;

  /// No description provided for @driverConflictMessage.
  ///
  /// In en, this message translates to:
  /// **'This Order changed while you were offline. Refresh the Order before continuing.'**
  String get driverConflictMessage;

  /// No description provided for @driverRefreshAction.
  ///
  /// In en, this message translates to:
  /// **'Refresh'**
  String get driverRefreshAction;

  /// No description provided for @holdStatus.
  ///
  /// In en, this message translates to:
  /// **'On Hold'**
  String get holdStatus;

  /// No description provided for @hold.
  ///
  /// In en, this message translates to:
  /// **'Hold'**
  String get hold;

  /// No description provided for @orderPlacedOnHold.
  ///
  /// In en, this message translates to:
  /// **'Order placed on Hold.'**
  String get orderPlacedOnHold;
}

class _AppLocalizationsDelegate
    extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['ar', 'en'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'ar':
      return AppLocalizationsAr();
    case 'en':
      return AppLocalizationsEn();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}
