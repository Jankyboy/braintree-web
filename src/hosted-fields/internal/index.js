'use strict';

var assign = require('../../lib/assign').assign;
var Bus = require('../../lib/bus');
var Promise = require('../../lib/promise');
var convertToBraintreeError = require('../../lib/convert-to-braintree-error');
var frameName = require('./get-frame-name');
var assembleIFrames = require('./assemble-iframes');
var Client = require('../../client/client');
var injectWithAllowList = require('inject-stylesheet').injectWithAllowlist;
var CreditCardForm = require('./models/credit-card-form').CreditCardForm;
var FieldComponent = require('./components/field-component').FieldComponent;
var analytics = require('../../lib/analytics');
var BraintreeError = require('../../lib/braintree-error');
var constants = require('../shared/constants');
var browserDetection = require('../shared/browser-detection');
var errors = require('../shared/errors');
var events = constants.events;
var allowedStyles = constants.allowedStyles;
var tokenizationErrorCodes = constants.tokenizationErrorCodes;
var formatCardRequestData = require('./format-card-request-data');
var normalizeCardType = require('./normalize-card-type');
var focusIntercept = require('../shared/focus-intercept');

var CHECK_FOR_NEW_AUTOFILL_DATA_INTERVAL = 100;
var ALLOWED_BILLING_ADDRESS_FIELDS = [
  'company',
  'countryCodeNumeric',
  'countryCodeAlpha2',
  'countryCodeAlpha3',
  'countryName',
  'extendedAddress',
  'locality',
  'region',
  'firstName',
  'lastName',
  'postalCode',
  'streetAddress'
];

function initialize(cardForm) {
  var fieldComponent;
  var name = frameName.getFrameName();
  var form = document.createElement('form');

  form.setAttribute('novalidate', true);
  form.setAttribute('action', '#'); // Forms need an action in order to offer a "go" button on soft keyboard
  form.addEventListener('submit', function (event) {
    event.preventDefault();
  });

  injectWithAllowList(
    cardForm.configuration.styles,
    allowedStyles
  );

  fieldComponent = new FieldComponent({
    cardForm: cardForm,
    type: name
  });

  form.appendChild(fieldComponent.element);

  if (name === 'number' && !cardForm.configuration.preventAutofill) {
    createInputsForAutofill(form);
  }

  window.bus.on(events.AUTOFILL_DATA_AVAILABLE, autofillHandler(fieldComponent));

  window.bus.on(events.REMOVE_FOCUS_INTERCEPTS, function (data) {
    focusIntercept.destroy(data && data.id);
  });

  document.body.appendChild(form);

  shimPlaceholder();
}

function makeMockInput(name) {
  var fragment = document.createDocumentFragment();
  var label = document.createElement('label');
  var input = document.createElement('input');

  label.setAttribute('aria-hidden', true);
  label.setAttribute('for', name + '-autofill-field');
  label.textContent = name;

  input.setAttribute('aria-hidden', true);
  input.id = name + '-autofill-field';
  input.className = 'autofill-field';
  input.type = 'text';
  input.name = name;
  input.setAttribute('autocomplete', constants.autocompleteMappings[name]);

  // Normally we'd mark these hidden inputs
  // with tabindex=-1 to prevent the customer
  // from accidentally navigating to them via
  // the tab key or software keyboard arrows.
  // This is fine in most browsers, but Chrome
  // for iOS has a custom autofill implementation
  // that will not fill in any inputs that have tabindex
  // set to -1. To get around this, we simply do not
  // set the tabindex property for iOS Chrome, but
  // this leaves the software arrows, making it possible
  // for the customer to jump to the hidden inputs
  // inside those iframes. To mitigate this, we simply
  // blur the hidden input when it is focussed this way.
  // We have fancy logic in most browsers to navigate
  // to the following Hosted Fields iframe when a
  // tab event is detected, but iOS does not allow us
  // to do that anyway, so there's little downside to
  // doing this blurring strategy for now. In the future,
  // if Safari allows us to programmatically focus on
  // another Hosted Fields iframe, we should update
  // this logic to focus the next Hosted Fields iframe.
  if (browserDetection.isChromeIos()) {
    input.addEventListener('focus', function () {
      input.blur();
    });
  } else {
    input.setAttribute('tabindex', -1);
  }

  fragment.appendChild(label);
  fragment.appendChild(input);

  return fragment;
}

function fix1PasswordAdjustment(form) {
  // 1Password autofill throws the form
  // positioning off screen. By toggling
  // the position, we can prevent the number
  // field from dissapearing
  form.style.position = 'relative';
  form.style.position = 'absolute';
}

function createInputsForAutofill(form) {
  var cachedValues = {
    month: '',
    year: '',
    cvv: ''
  };
  var expMonth = makeMockInput('expiration-month');
  var expYear = makeMockInput('expiration-year');
  var cvv = makeMockInput('cvv');
  var expMonthInput = expMonth.querySelector('input');
  var expYearInput = expYear.querySelector('input');
  var cvvInput = cvv.querySelector('input');

  setInterval(function () {
    if (
      cachedValues.month !== expMonthInput.value ||
      cachedValues.year !== expYearInput.value ||
      cachedValues.cvv !== cvvInput.value
    ) {
      cachedValues.month = expMonthInput.value;
      cachedValues.year = expYearInput.value;
      cachedValues.cvv = cvvInput.value;

      fix1PasswordAdjustment(form);
      window.bus.emit(events.AUTOFILL_DATA_AVAILABLE, {
        month: expMonthInput.value,
        year: expYearInput.value,
        cvv: cvvInput.value
      });
    }
  }, CHECK_FOR_NEW_AUTOFILL_DATA_INTERVAL);

  form.appendChild(expMonth);
  form.appendChild(expYear);
  form.appendChild(cvv);
}

function autofillHandler(fieldComponent) {
  return function (payload) {
    var name, value, month, year, cvv, thisYear;

    if (!payload || !payload.month || !payload.year) {
      return;
    }

    name = frameName.getFrameName();
    month = payload.month;
    year = payload.year;
    cvv = payload.cvv;

    if (year.length === 2) {
      thisYear = String((new Date()).getFullYear()); // eslint-disable-line no-extra-parens
      year = thisYear.substring(0, 2) + year;
    }

    if (name === 'expirationDate') {
      value = month + ' / ' + year;
    } else if (name === 'expirationMonth') {
      value = month;
    } else if (name === 'expirationYear') {
      value = year;
    } else if (name === 'cvv' && cvv) {
      value = cvv;
    }

    if (value) {
      fieldComponent.input.updateModel('value', value);

      if (fieldComponent.input.shouldMask) {
        fieldComponent.input.maskValue(value);
      } else {
        fieldComponent.input.element.value = value;
      }

      resetPlaceholder(fieldComponent.input.element);
    }
  };
}

function resetPlaceholder(element) {
  // Safari leaves the placholder visible in the iframe, we
  // compensate for this by removing and re-setting the placeholder
  var placeholder = element.getAttribute('placeholder');

  if (placeholder) {
    element.setAttribute('placeholder', '');
    element.setAttribute('placeholder', placeholder);
  }
}

function shimPlaceholder() {
  var input;

  if (!window.placeholderShim) { return; }

  input = document.querySelector('input[data-braintree-name]');
  if (!input) { return; }

  window.placeholderShim(input);
}

function create() {
  var componentId = location.hash.slice(1, location.hash.length);
  var name = frameName.getFrameName();

  window.bus = new Bus({channel: componentId});

  window.bus.emit(events.FRAME_READY, {
    field: name
  }, orchestrate);
}

function createTokenizationHandler(clientInstanceOrPromise, cardForm) {
  return function (options, reply) {
    var data;

    Promise.resolve(clientInstanceOrPromise).then(function (client) {
      var mergedCardData, creditCardDetails;
      var fieldsToTokenize = options.fieldsToTokenize;
      var isEmpty = cardForm.isEmpty(fieldsToTokenize);
      var invalidFieldKeys = cardForm.invalidFieldKeys(fieldsToTokenize);
      var isValid = invalidFieldKeys.length === 0;
      var authInsight = options.authenticationInsight;
      var merchantAccountIdForAuthInsight = authInsight && authInsight.merchantAccountId;

      if (isEmpty) {
        reply([new BraintreeError(errors.HOSTED_FIELDS_FIELDS_EMPTY)]);

        return Promise.resolve();
      } else if (!isValid) {
        reply([new BraintreeError({
          type: errors.HOSTED_FIELDS_FIELDS_INVALID.type,
          code: errors.HOSTED_FIELDS_FIELDS_INVALID.code,
          message: errors.HOSTED_FIELDS_FIELDS_INVALID.message,
          details: {invalidFieldKeys: invalidFieldKeys}
        })]);

        return Promise.resolve();
      }

      options = options || {};

      mergedCardData = mergeCardData(cardForm.getCardData(fieldsToTokenize), options);

      creditCardDetails = formatCardRequestData(mergedCardData);

      creditCardDetails.options = {
        validate: options.vault === true
      };

      data = {
        _meta: {
          source: 'hosted-fields'
        },
        creditCard: creditCardDetails
      };

      if (merchantAccountIdForAuthInsight) {
        data.authenticationInsight = true;
        data.merchantAccountId = merchantAccountIdForAuthInsight;
      }

      return client.request({
        api: 'clientApi',
        method: 'post',
        endpoint: 'payment_methods/credit_cards',
        data: data
      }).then(function (clientApiResult) {
        var clientApiCreditCard = clientApiResult.creditCards[0];
        var result = {
          nonce: clientApiCreditCard.nonce,
          details: clientApiCreditCard.details,
          description: clientApiCreditCard.description,
          type: clientApiCreditCard.type,
          binData: clientApiCreditCard.binData
        };

        if (clientApiCreditCard.authenticationInsight) {
          result.authenticationInsight = clientApiCreditCard.authenticationInsight;
        }

        analytics.sendEvent(clientInstanceOrPromise, 'custom.hosted-fields.tokenization.succeeded');

        reply([null, result]);
      }).catch(function (clientApiError) {
        var formattedError = formatTokenizationError(clientApiError);

        analytics.sendEvent(clientInstanceOrPromise, 'custom.hosted-fields.tokenization.failed');

        reply([formattedError]);
      });
    });
  };
}

function formatTokenizationError(err) {
  var formattedError, rootError, code;
  var status = err.details && err.details.httpStatus;

  if (status === 403) {
    formattedError = err;
  } else if (status < 500) {
    try {
      rootError = BraintreeError.findRootError(err);
      code = rootError.fieldErrors[0].fieldErrors[0].code;
    } catch (e) {
      // just bail out if code property cannot be found on rootError
    }

    if (tokenizationErrorCodes.hasOwnProperty(code)) {
      formattedError = convertToBraintreeError(rootError, tokenizationErrorCodes[code]);
    } else {
      formattedError = new BraintreeError(errors.HOSTED_FIELDS_FAILED_TOKENIZATION);
      formattedError.details = {originalError: err};
    }
  } else {
    formattedError = new BraintreeError(errors.HOSTED_FIELDS_TOKENIZATION_NETWORK_ERROR);
    formattedError.details = {originalError: err};
  }

  return formattedError;
}

function orchestrate(configuration) {
  var cardForm = new CreditCardForm(configuration);
  var iframes = assembleIFrames.assembleIFrames(window.parent);
  var clientPromise = new Promise(function (resolve) {
    window.bus.emit(events.READY_FOR_CLIENT, function (configurationFromMerchantPage) {
      resolve(new Client(configurationFromMerchantPage));
    });
  }).then(function (client) {
    var supportedCardBrands;
    var numberConfig = configuration.fields.number;

    if (numberConfig && (numberConfig.supportedCardBrands || numberConfig.rejectUnsupportedCards)) {
      supportedCardBrands = getSupportedCardBrands(client, numberConfig.supportedCardBrands);

      // NEXT_MAJOR_VERSION rejecting unsupported cards should be the default behavior after the next major revision
      cardForm.setSupportedCardTypes(supportedCardBrands);
      // force a validation now that the validation rules have changed
      cardForm.validateField('number');
    }

    return client;
  });

  iframes.forEach(function (iframe) {
    try {
      iframe.braintree.hostedFields.initialize(cardForm);
    } catch (e) { /* noop */ }
  });

  analytics.sendEvent(clientPromise, 'custom.hosted-fields.load.succeeded');

  window.bus.on(events.TOKENIZATION_REQUEST, function (options, reply) {
    var tokenizationHandler = createTokenizationHandler(clientPromise, cardForm);

    tokenizationHandler(options, reply);
  });

  // Globalize cardForm is global so other components (UnionPay) can access it
  window.cardForm = cardForm;

  return clientPromise;
}

function getSupportedCardBrands(client, merchantConfiguredCardBrands) {
  var supportedCardBrands;
  var gwConfiguration = client.getConfiguration().gatewayConfiguration.creditCards;
  var gwSupportedCards = gwConfiguration && gwConfiguration.supportedCardTypes.map(normalizeCardType);

  // when using the forward api, there may not be
  // a merchant configuration for credit cards
  gwSupportedCards = gwSupportedCards || [];
  merchantConfiguredCardBrands = merchantConfiguredCardBrands || {};

  supportedCardBrands = gwSupportedCards.reduce(function (brands, cardBrand) {
    brands[cardBrand] = true;

    return brands;
  }, {});
  Object.keys(merchantConfiguredCardBrands).forEach(function (brand) {
    supportedCardBrands[normalizeCardType(brand)] = merchantConfiguredCardBrands[brand];
  });

  return supportedCardBrands;
}

function mergeCardData(cardData, options) {
  var newCardData;
  var userProvidedCardData = assign({}, options.billingAddress);
  var cardholderName = options.cardholderName;

  Object.keys(userProvidedCardData).forEach(function (field) {
    if (ALLOWED_BILLING_ADDRESS_FIELDS.indexOf(field) === -1 || cardData.hasOwnProperty(field)) {
      delete userProvidedCardData[field];
    }
  });

  if (cardholderName) {
    userProvidedCardData.cardholderName = cardholderName;
  }

  newCardData = assign({}, cardData, userProvidedCardData);

  return newCardData;
}

module.exports = {
  initialize: initialize,
  create: create,
  orchestrate: orchestrate,
  createTokenizationHandler: createTokenizationHandler,
  autofillHandler: autofillHandler
};
